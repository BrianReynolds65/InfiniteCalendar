using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;

namespace InfiniteCalendar.Api;

public sealed record GoogleOAuthSettings(string ClientId, string ClientSecret, string FrontendOrigin, string SessionDirectory)
{
    public const string CalendarEventsScope = "https://www.googleapis.com/auth/calendar.events";
    public const string CalendarListScope = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
    public const string CalendarScopes = $"{CalendarEventsScope} {CalendarListScope}";
    public bool IsConfigured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);
    public string CallbackUri => $"{FrontendOrigin}/auth/callback";

    public static string RandomUrlToken(int byteCount) =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(byteCount))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed record GoogleTokenRecord(
    string AccessToken,
    string RefreshToken,
    DateTimeOffset ExpiresAt,
    string? Scope = null);

public sealed class GoogleTokenResponse
{
    [JsonPropertyName("access_token")]
    public string? AccessToken { get; init; }

    [JsonPropertyName("refresh_token")]
    public string? RefreshToken { get; init; }

    [JsonPropertyName("expires_in")]
    public int ExpiresIn { get; init; }

    [JsonPropertyName("scope")]
    public string? Scope { get; init; }
}

public sealed record GoogleEventWriteRequest(
    string? Id,
    string CalendarId,
    string Title,
    string Start,
    string End,
    bool AllDay);

public sealed record GoogleEventDeleteRequest(
    string EventId,
    string CalendarId,
    bool WholeSeries);

public sealed class GoogleTokenStore
{
    private readonly IDataProtector _protector;
    private readonly IDataProtector _selectionProtector;
    private readonly string _directory;

    public GoogleTokenStore(IDataProtectionProvider protectionProvider, GoogleOAuthSettings settings)
    {
        _protector = protectionProvider.CreateProtector("InfiniteCalendar.GoogleTokens.v1");
        _selectionProtector = protectionProvider.CreateProtector("InfiniteCalendar.CalendarSelection.v1");
        _directory = settings.SessionDirectory;
        Directory.CreateDirectory(_directory);
    }

    public async Task SaveAsync(string sessionId, GoogleTokenRecord record)
    {
        await SaveEncryptedAsync(GetPath(sessionId), _protector, JsonSerializer.Serialize(record));
    }

    public async Task<GoogleTokenRecord?> LoadAsync(string sessionId)
    {
        var path = GetPath(sessionId);
        if (!File.Exists(path)) return null;
        var encrypted = await File.ReadAllTextAsync(path);
        var json = _protector.Unprotect(encrypted);
        return JsonSerializer.Deserialize<GoogleTokenRecord>(json);
    }

    public async Task<string[]?> GetSelectedCalendarIdsAsync(string sessionId)
    {
        var path = GetSelectionPath(sessionId);
        if (!File.Exists(path)) return null;
        var encrypted = await File.ReadAllTextAsync(path);
        return JsonSerializer.Deserialize<string[]>(_selectionProtector.Unprotect(encrypted));
    }

    public async Task SaveSelectedCalendarIdsAsync(string sessionId, string[] calendarIds)
    {
        await SaveEncryptedAsync(GetSelectionPath(sessionId), _selectionProtector, JsonSerializer.Serialize(calendarIds));
    }

    public Task DeleteAsync(string sessionId)
    {
        foreach (var path in new[] { GetPath(sessionId), GetSelectionPath(sessionId) })
        {
            if (File.Exists(path)) File.Delete(path);
        }
        return Task.CompletedTask;
    }

    private async Task SaveEncryptedAsync(string path, IDataProtector protector, string content)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        var encrypted = protector.Protect(content);
        await File.WriteAllTextAsync(temporaryPath, encrypted);
        File.Move(temporaryPath, path, true);
    }

    private string GetPath(string sessionId) =>
        Path.Combine(_directory, $"{GetSessionFileName(sessionId)}.json");

    private string GetSelectionPath(string sessionId) =>
        Path.Combine(_directory, $"{GetSessionFileName(sessionId)}.selection");

    private static string GetSessionFileName(string sessionId) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sessionId)));
}

public sealed class GoogleCalendarApi(
    HttpClient httpClient,
    GoogleOAuthSettings settings,
    GoogleTokenStore tokenStore,
    ILogger<GoogleCalendarApi> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task EnsureSessionAsync(string sessionId) => _ = await GetAccessTokenAsync(sessionId);

    public async Task<IReadOnlyList<GoogleCalendar>> ListCalendarsAsync(string sessionId)
    {
        var token = await GetAccessTokenAsync(sessionId);
        var result = await GetAsync<CalendarListResponse>(
            "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250",
            token);
        return result.Items ?? [];
    }

    public async Task SaveSelectedCalendarIdsAsync(string sessionId, string[] calendarIds)
    {
        var availableIds = (await ListCalendarsAsync(sessionId))
            .Select(calendar => calendar.Id)
            .ToHashSet(StringComparer.Ordinal);
        if (calendarIds.Any(id => !availableIds.Contains(id)))
            throw new GoogleApiException(
                "A selected calendar is not available to this Google account.",
                HttpStatusCode.BadRequest);

        await tokenStore.SaveSelectedCalendarIdsAsync(
            sessionId,
            calendarIds.Distinct(StringComparer.Ordinal).ToArray());
    }

    public async Task<IReadOnlyList<CalendarEvent>> ListEventsAsync(
        string sessionId,
        string[] calendarIds,
        DateTimeOffset timeMin,
        DateTimeOffset timeMax)
    {
        var token = await GetAccessTokenAsync(sessionId);
        var calendars = await ListCalendarsAsync(sessionId);
        var calendarById = calendars.ToDictionary(calendar => calendar.Id, StringComparer.Ordinal);
        var requestedCalendars = calendarIds.Distinct(StringComparer.Ordinal)
            .Select(id => calendarById.TryGetValue(id, out var calendar)
                ? calendar
                : throw new GoogleApiException(
                    "A selected calendar is not available to this Google account.",
                    HttpStatusCode.BadRequest))
            .ToArray();

        var responses = await Task.WhenAll(requestedCalendars.Select(async calendar =>
        {
            var query = new Dictionary<string, string?>
            {
                ["timeMin"] = timeMin.ToUniversalTime().ToString("O"),
                ["timeMax"] = timeMax.ToUniversalTime().ToString("O"),
                ["singleEvents"] = "true",
                ["orderBy"] = "startTime",
                ["maxResults"] = "2500",
            };
            var uri = QueryHelpers.AddQueryString(
                $"https://www.googleapis.com/calendar/v3/calendars/{Uri.EscapeDataString(calendar.Id)}/events",
                query);
            var result = await GetAsync<EventListResponse>(uri, token);
            return (result.Items ?? []).Where(item => item.Id is not null && item.Start?.Value is not null && item.End?.Value is not null)
                .Select(item => new CalendarEvent(
                    $"{calendar.Id}:{item.Id}",
                    calendar.Id,
                    item.Summary ?? "(Untitled event)",
                    item.Start!.Value!,
                    item.End!.Value!,
                    item.Start.DateTime is null,
                    calendar.BackgroundColor ?? "#16866a",
                    item.Location,
                    item.RecurringEventId))
                .ToArray();
        }));

        return responses.SelectMany(response => response).OrderBy(item => item.Start, StringComparer.Ordinal).ToArray();
    }

    public async Task SaveEventAsync(string sessionId, GoogleEventWriteRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            throw new GoogleApiException("Enter an event title of 1 to 500 characters.", HttpStatusCode.BadRequest);
        var title = request.Title.Trim();
        if (title.Length is 0 or > 500)
            throw new GoogleApiException("Enter an event title of 1 to 500 characters.", HttpStatusCode.BadRequest);
        if (string.IsNullOrWhiteSpace(request.CalendarId))
            throw new GoogleApiException("Choose a calendar for this event.", HttpStatusCode.BadRequest);

        object start;
        object end;
        if (request.AllDay)
        {
            if (!DateOnly.TryParseExact(request.Start, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var startDate)
                || !DateOnly.TryParseExact(request.End, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var endDate)
                || endDate <= startDate)
                throw new GoogleApiException("Choose an end date after the start date.", HttpStatusCode.BadRequest);

            start = new { date = request.Start };
            end = new { date = request.End };
        }
        else
        {
            if (!DateTimeOffset.TryParse(request.Start, CultureInfo.InvariantCulture, DateTimeStyles.None, out var startTime)
                || !DateTimeOffset.TryParse(request.End, CultureInfo.InvariantCulture, DateTimeStyles.None, out var endTime)
                || endTime <= startTime)
                throw new GoogleApiException("Choose an end time after the start time.", HttpStatusCode.BadRequest);

            start = new { dateTime = startTime.ToString("O", CultureInfo.InvariantCulture) };
            end = new { dateTime = endTime.ToString("O", CultureInfo.InvariantCulture) };
        }

        var calendar = (await ListCalendarsAsync(sessionId))
            .FirstOrDefault(item => string.Equals(item.Id, request.CalendarId, StringComparison.Ordinal));
        if (calendar is null)
            throw new GoogleApiException("This calendar is not available to your Google account.", HttpStatusCode.BadRequest);

        var uri = $"https://www.googleapis.com/calendar/v3/calendars/{Uri.EscapeDataString(calendar.Id)}/events";
        HttpMethod method = HttpMethod.Post;
        if (request.Id is not null)
        {
            var eventPrefix = $"{calendar.Id}:";
            if (!request.Id.StartsWith(eventPrefix, StringComparison.Ordinal)
                || request.Id.Length == eventPrefix.Length)
                throw new GoogleApiException("This event cannot be edited on the selected calendar.", HttpStatusCode.BadRequest);
            uri += $"/{Uri.EscapeDataString(request.Id[eventPrefix.Length..])}";
            method = HttpMethod.Put;
        }

        var payload = new { summary = title, start, end };
        using var httpRequest = new HttpRequestMessage(method, uri)
        {
            Content = JsonContent.Create(payload, options: JsonOptions),
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetAccessTokenAsync(sessionId));
        using var response = await httpClient.SendAsync(httpRequest);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<GoogleErrorEnvelope>(JsonOptions);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                throw new GoogleSessionException("Google authorization expired. Please connect again.");
            throw new GoogleApiException(
                error?.Error?.Message ?? $"Google Calendar could not save the event ({(int)response.StatusCode}).",
                response.StatusCode);
        }
    }

    public async Task DeleteEventAsync(string sessionId, GoogleEventDeleteRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.CalendarId) || string.IsNullOrWhiteSpace(request.EventId))
            throw new GoogleApiException("Choose an event to delete.", HttpStatusCode.BadRequest);

        var calendar = (await ListCalendarsAsync(sessionId))
            .FirstOrDefault(item => string.Equals(item.Id, request.CalendarId, StringComparison.Ordinal));
        if (calendar is null)
            throw new GoogleApiException("This calendar is not available to your Google account.", HttpStatusCode.BadRequest);

        var eventPrefix = $"{calendar.Id}:";
        if (!request.EventId.StartsWith(eventPrefix, StringComparison.Ordinal)
            || request.EventId.Length == eventPrefix.Length)
            throw new GoogleApiException("This event cannot be deleted from the selected calendar.", HttpStatusCode.BadRequest);

        var eventId = request.EventId[eventPrefix.Length..];
        var accessToken = await GetAccessTokenAsync(sessionId);
        if (request.WholeSeries)
        {
            var instanceUri = $"https://www.googleapis.com/calendar/v3/calendars/{Uri.EscapeDataString(calendar.Id)}/events/{Uri.EscapeDataString(eventId)}";
            var instance = await GetAsync<GoogleEvent>(instanceUri, accessToken);
            if (string.IsNullOrWhiteSpace(instance.RecurringEventId))
                throw new GoogleApiException("This event is not part of a recurring series.", HttpStatusCode.BadRequest);
            eventId = instance.RecurringEventId;
        }

        var uri = $"https://www.googleapis.com/calendar/v3/calendars/{Uri.EscapeDataString(calendar.Id)}/events/{Uri.EscapeDataString(eventId)}";
        using var httpRequest = new HttpRequestMessage(HttpMethod.Delete, uri);
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await httpClient.SendAsync(httpRequest);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<GoogleErrorEnvelope>(JsonOptions);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                throw new GoogleSessionException("Google authorization expired. Please connect again.");
            throw new GoogleApiException(
                error?.Error?.Message ?? $"Google Calendar could not delete the event ({(int)response.StatusCode}).",
                response.StatusCode);
        }
    }

    private async Task<string> GetAccessTokenAsync(string sessionId)
    {
        var record = await tokenStore.LoadAsync(sessionId);
        if (record is null)
            throw new GoogleSessionException("The Google session is missing or expired.");
        var grantedScopes = (record.Scope ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (!grantedScopes.Contains(GoogleOAuthSettings.CalendarEventsScope, StringComparer.Ordinal)
            || !grantedScopes.Contains(GoogleOAuthSettings.CalendarListScope, StringComparer.Ordinal))
            throw new GoogleSessionException("Google Calendar read and edit access is required. Please disconnect and reconnect, then approve both requested permissions.");
        if (record.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(1))
            return record.AccessToken;
        if (!settings.IsConfigured)
            throw new GoogleSessionException("Google OAuth is not configured.");

        using var response = await httpClient.PostAsync(
            "https://oauth2.googleapis.com/token",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = settings.ClientId,
                ["client_secret"] = settings.ClientSecret,
                ["refresh_token"] = record.RefreshToken,
                ["grant_type"] = "refresh_token",
            }));

        if (response.StatusCode == HttpStatusCode.BadRequest)
            throw new GoogleSessionException("Google could not refresh authorization. Please connect again.");
        if (!response.IsSuccessStatusCode)
            throw new GoogleApiException("Google token refresh failed.", response.StatusCode);

        var refreshed = await response.Content.ReadFromJsonAsync<GoogleTokenResponse>();
        if (refreshed?.AccessToken is null)
            throw new GoogleSessionException("Google did not return a refreshed access token.");

        var updated = new GoogleTokenRecord(
            refreshed.AccessToken,
            refreshed.RefreshToken ?? record.RefreshToken,
            DateTimeOffset.UtcNow.AddSeconds(refreshed.ExpiresIn),
            record.Scope);
        await tokenStore.SaveAsync(sessionId, updated);
        logger.LogDebug("Refreshed the Google access token for a calendar session.");
        return updated.AccessToken;
    }

    private async Task<T> GetAsync<T>(string uri, string accessToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await httpClient.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<GoogleErrorEnvelope>(JsonOptions);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
                throw new GoogleSessionException("Google authorization expired. Please connect again.");
            throw new GoogleApiException(
                error?.Error?.Message ?? $"Google Calendar request failed ({(int)response.StatusCode}).",
                response.StatusCode);
        }

        var result = await response.Content.ReadFromJsonAsync<T>(JsonOptions);
        return result ?? throw new GoogleApiException("Google Calendar returned an empty response.", HttpStatusCode.BadGateway);
    }
}

public sealed record GoogleCalendar(
    string Id,
    string Summary,
    string? BackgroundColor,
    bool? Primary);

public sealed record CalendarEvent(
    string Id,
    string CalendarId,
    string Title,
    string Start,
    string End,
    bool AllDay,
    string Color,
    string? Location,
    string? RecurringEventId = null);

internal sealed class CalendarListResponse
{
    public GoogleCalendar[]? Items { get; init; }
}

internal sealed class EventListResponse
{
    public GoogleEvent[]? Items { get; init; }
}

internal sealed class GoogleEvent
{
    public string? Id { get; init; }
    public string? Summary { get; init; }
    public string? Location { get; init; }
    public GoogleEventDate? Start { get; init; }
    public GoogleEventDate? End { get; init; }
    public string? RecurringEventId { get; init; }
}

internal sealed class GoogleEventDate
{
    [JsonPropertyName("date")]
    public string? Date { get; init; }

    [JsonPropertyName("dateTime")]
    public string? DateTime { get; init; }

    [JsonIgnore]
    public string? Value => DateTime ?? Date;
}

internal sealed class GoogleErrorEnvelope
{
    public GoogleApiError? Error { get; init; }
}

internal sealed class GoogleApiError
{
    public string? Message { get; init; }
}

public sealed class GoogleSessionException(string message) : Exception(message);

public sealed class GoogleApiException(string message, HttpStatusCode statusCode) : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}
