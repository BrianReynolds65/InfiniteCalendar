using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace InfiniteCalendar.Api;

/// <summary>Represents the shared note and its current revision.</summary>
public sealed record SharedNoteResponse(bool IsOpen, string Text, long Version);

/// <summary>Updates the shared note's text if it has not changed since it was read.</summary>
public sealed record SaveSharedNoteTextRequest(string? Text, long ExpectedVersion);

public interface ISharedNoteStore
{
    Task<SharedNoteResponse> GetAsync(CancellationToken cancellationToken);
    Task<SharedNoteResponse> OpenAsync(CancellationToken cancellationToken);
    Task<SharedNoteResponse> SaveTextAsync(
        SaveSharedNoteTextRequest request,
        CancellationToken cancellationToken);
    Task<SharedNoteResponse> DismissAsync(CancellationToken cancellationToken);
}

public sealed class SharedNoteStore : ISharedNoteStore
{
    public const int MaximumTextLength = 50_000;

    private readonly IDataProtector _protector;
    private readonly string _filePath;
    private readonly SemaphoreSlim _mutex = new(1, 1);

    public SharedNoteStore(IDataProtectionProvider protectionProvider, string filePath)
    {
        _protector = protectionProvider.CreateProtector("InfiniteCalendar.SharedNote.v1");
        _filePath = filePath;
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
    }

    public async Task<SharedNoteResponse> GetAsync(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            return await ReadAsync(cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<SharedNoteResponse> OpenAsync(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            if (current.IsOpen)
                return current;

            var opened = new SharedNoteResponse(true, string.Empty, checked(current.Version + 1));
            await WriteAsync(opened, cancellationToken);
            return opened;
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<SharedNoteResponse> SaveTextAsync(
        SaveSharedNoteTextRequest request,
        CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            if (!current.IsOpen || current.Version != request.ExpectedVersion)
                return current;

            var updated = current with
            {
                Text = request.Text!,
                Version = checked(current.Version + 1),
            };
            await WriteAsync(updated, cancellationToken);
            return updated;
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<SharedNoteResponse> DismissAsync(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            if (!current.IsOpen && current.Text.Length == 0)
                return current;

            var dismissed = new SharedNoteResponse(false, string.Empty, checked(current.Version + 1));
            await WriteAsync(dismissed, cancellationToken);
            return dismissed;
        }
        finally
        {
            _mutex.Release();
        }
    }

    private async Task WriteAsync(SharedNoteResponse note, CancellationToken cancellationToken)
    {
        var protectedJson = _protector.Protect(JsonSerializer.Serialize(note));
        var temporaryPath = $"{_filePath}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllTextAsync(temporaryPath, protectedJson, cancellationToken);
        File.Move(temporaryPath, _filePath, overwrite: true);
    }

    private async Task<SharedNoteResponse> ReadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_filePath))
            return new SharedNoteResponse(false, string.Empty, 0);

        var protectedJson = await File.ReadAllTextAsync(_filePath, cancellationToken);
        var json = _protector.Unprotect(protectedJson);
        return JsonSerializer.Deserialize<SharedNoteResponse>(json)
            ?? throw new InvalidDataException("The saved shared note is invalid.");
    }
}
