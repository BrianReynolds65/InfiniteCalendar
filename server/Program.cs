using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using InfiniteCalendar.Api;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;

var builder = WebApplication.CreateBuilder(args);
var dataDirectory = builder.Configuration["InfiniteCalendar:DataDirectory"]
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "InfiniteCalendar");
var keyDirectory = Path.Combine(dataDirectory, "keys");
Directory.CreateDirectory(keyDirectory);

builder.Services.AddDataProtection()
    .SetApplicationName("InfiniteCalendar")
    .PersistKeysToFileSystem(new DirectoryInfo(keyDirectory));
builder.Services.AddSingleton(new GoogleOAuthSettings(
    builder.Configuration["Google:ClientId"] ?? string.Empty,
    builder.Configuration["Google:ClientSecret"] ?? string.Empty,
    (builder.Configuration["Google:FrontendOrigin"] ?? "http://localhost:5173").TrimEnd('/'),
    Path.Combine(dataDirectory, "sessions")));
builder.Services.AddSingleton<GoogleTokenStore>();
builder.Services.AddHttpClient<GoogleCalendarApi>();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "Daybook.Session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
            ? CookieSecurePolicy.SameAsRequest
            : CookieSecurePolicy.Always;
        options.ExpireTimeSpan = TimeSpan.FromDays(30);
        options.SlidingExpiration = true;
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();
var oauth = app.Services.GetRequiredService<GoogleOAuthSettings>();
var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("GoogleOAuth");

app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (GoogleSessionException exception)
    {
        var sessionId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (sessionId is not null)
            await context.RequestServices.GetRequiredService<GoogleTokenStore>().DeleteAsync(sessionId);
        await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = exception.Message });
    }
    catch (GoogleApiException exception)
    {
        context.Response.StatusCode = exception.StatusCode == System.Net.HttpStatusCode.BadRequest
            ? StatusCodes.Status400BadRequest
            : StatusCodes.Status502BadGateway;
        await context.Response.WriteAsJsonAsync(new { error = exception.Message });
    }
});

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/auth/google", (HttpContext context) =>
{
    if (!oauth.IsConfigured)
        return Results.Problem("Set Google:ClientId and Google:ClientSecret in the backend configuration first.", statusCode: 503);

    var state = GoogleOAuthSettings.RandomUrlToken(32);
    var verifier = GoogleOAuthSettings.RandomUrlToken(48);
    var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    var cookieOptions = new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Lax,
        Secure = !app.Environment.IsDevelopment(),
        Path = "/auth",
        MaxAge = TimeSpan.FromMinutes(10),
    };
    context.Response.Cookies.Append("Daybook.OAuthState", state, cookieOptions);
    context.Response.Cookies.Append("Daybook.PkceVerifier", verifier, cookieOptions);

    var query = new Dictionary<string, string?>
    {
        ["client_id"] = oauth.ClientId,
        ["redirect_uri"] = oauth.CallbackUri,
        ["response_type"] = "code",
        ["scope"] = GoogleOAuthSettings.CalendarScopes,
        ["access_type"] = "offline",
        ["prompt"] = "consent",
        ["state"] = state,
        ["code_challenge"] = challenge,
        ["code_challenge_method"] = "S256",
    };
    var authorizationUri = QueryHelpers.AddQueryString("https://accounts.google.com/o/oauth2/v2/auth", query);
    return Results.Redirect(authorizationUri);
});

app.MapGet("/auth/callback", async (
    HttpContext context,
    IHttpClientFactory clients,
    GoogleTokenStore tokenStore) =>
{
    var returnedState = context.Request.Query["state"].ToString();
    var savedState = context.Request.Cookies["Daybook.OAuthState"];
    var verifier = context.Request.Cookies["Daybook.PkceVerifier"];
    context.Response.Cookies.Delete("Daybook.OAuthState", new CookieOptions { Path = "/auth" });
    context.Response.Cookies.Delete("Daybook.PkceVerifier", new CookieOptions { Path = "/auth" });

    if (string.IsNullOrEmpty(returnedState) || string.IsNullOrEmpty(savedState)
        || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(returnedState), Encoding.UTF8.GetBytes(savedState))
        || string.IsNullOrEmpty(verifier))
        return Results.BadRequest("Invalid Google OAuth state. Please restart sign-in.");

    if (context.Request.Query.ContainsKey("error"))
        return Results.Redirect($"{oauth.FrontendOrigin}/?oauthError=google_signin_cancelled");

    var code = context.Request.Query["code"].ToString();
    if (string.IsNullOrWhiteSpace(code))
        return Results.BadRequest("Google did not return an authorization code.");

    using var response = await clients.CreateClient().PostAsync(
        "https://oauth2.googleapis.com/token",
        new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = code,
            ["client_id"] = oauth.ClientId,
            ["client_secret"] = oauth.ClientSecret,
            ["redirect_uri"] = oauth.CallbackUri,
            ["grant_type"] = "authorization_code",
            ["code_verifier"] = verifier,
        }));

    if (!response.IsSuccessStatusCode)
    {
        logger.LogWarning("Google authorization code exchange failed with status {StatusCode}.", (int)response.StatusCode);
        return Results.Redirect($"{oauth.FrontendOrigin}/?oauthError=google_signin_failed");
    }

    var tokenResponse = await response.Content.ReadFromJsonAsync<GoogleTokenResponse>();
    if (tokenResponse?.AccessToken is null || tokenResponse.RefreshToken is null)
    {
        logger.LogWarning("Google authorization did not return the access and refresh tokens required for a session.");
        return Results.Redirect($"{oauth.FrontendOrigin}/?oauthError=google_refresh_token_missing");
    }

    var sessionId = GoogleOAuthSettings.RandomUrlToken(32);
    await tokenStore.SaveAsync(sessionId, new GoogleTokenRecord(
        tokenResponse.AccessToken,
        tokenResponse.RefreshToken,
        DateTimeOffset.UtcNow.AddSeconds(tokenResponse.ExpiresIn),
        tokenResponse.Scope ?? GoogleOAuthSettings.CalendarScopes));

    var claims = new[] { new Claim(ClaimTypes.NameIdentifier, sessionId) };
    var identity = new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme);
    await context.SignInAsync(
        CookieAuthenticationDefaults.AuthenticationScheme,
        new ClaimsPrincipal(identity),
        new AuthenticationProperties
        {
            IsPersistent = true,
            AllowRefresh = true,
            ExpiresUtc = DateTimeOffset.UtcNow.AddDays(30),
        });

    return Results.Redirect(oauth.FrontendOrigin);
});

app.MapGet("/api/session", async (ClaimsPrincipal user, GoogleCalendarApi calendarApi) =>
{
    var sessionId = user.FindFirstValue(ClaimTypes.NameIdentifier);
    if (sessionId is null) return Results.Unauthorized();
    await calendarApi.EnsureSessionAsync(sessionId);
    return Results.Ok(new { connected = true });
}).RequireAuthorization();

app.MapGet("/api/calendars", async (ClaimsPrincipal user, GoogleCalendarApi calendarApi) =>
{
    var sessionId = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    return Results.Ok(await calendarApi.ListCalendarsAsync(sessionId));
}).RequireAuthorization();

app.MapGet("/api/calendar-selection", async (ClaimsPrincipal user, GoogleTokenStore tokenStore) =>
{
    var sessionId = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    return Results.Ok(new { calendarIds = await tokenStore.GetSelectedCalendarIdsAsync(sessionId) });
}).RequireAuthorization();

app.MapPut("/api/calendar-selection", async (
    HttpContext context,
    ClaimsPrincipal user,
    GoogleCalendarApi calendarApi,
    SaveCalendarSelectionRequest request) =>
{
    if (!Uri.TryCreate(context.Request.Headers.Origin, UriKind.Absolute, out var origin)
        || !string.Equals(origin.GetLeftPart(UriPartial.Authority), oauth.FrontendOrigin, StringComparison.OrdinalIgnoreCase))
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    if (request.CalendarIds is null || request.CalendarIds.Length > 250)
        return Results.BadRequest(new { error = "Select no more than 250 calendars." });

    var sessionId = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    await calendarApi.SaveSelectedCalendarIdsAsync(sessionId, request.CalendarIds);
    return Results.NoContent();
}).RequireAuthorization();

app.MapGet("/api/events", async (
    ClaimsPrincipal user,
    GoogleCalendarApi calendarApi,
    string[] calendarIds,
    DateTimeOffset timeMin,
    DateTimeOffset timeMax) =>
{
    if (calendarIds.Length == 0 || calendarIds.Length > 100)
        return Results.BadRequest(new { error = "Select between 1 and 100 calendars." });
    if (timeMin >= timeMax || timeMax - timeMin > TimeSpan.FromDays(366))
        return Results.BadRequest(new { error = "The event date range must be positive and no longer than one year." });

    var sessionId = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    return Results.Ok(await calendarApi.ListEventsAsync(sessionId, calendarIds, timeMin, timeMax));
}).RequireAuthorization();

app.MapPost("/api/events", async (
    HttpContext context,
    ClaimsPrincipal user,
    GoogleCalendarApi calendarApi,
    GoogleEventWriteRequest request) =>
{
    if (!Uri.TryCreate(context.Request.Headers.Origin, UriKind.Absolute, out var origin)
        || !string.Equals(origin.GetLeftPart(UriPartial.Authority), oauth.FrontendOrigin, StringComparison.OrdinalIgnoreCase))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    var sessionId = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    await calendarApi.SaveEventAsync(sessionId, request);
    return Results.NoContent();
}).RequireAuthorization();

app.MapPost("/auth/logout", async (HttpContext context, GoogleTokenStore tokenStore) =>
{
    var expectedOrigin = oauth.FrontendOrigin;
    if (!Uri.TryCreate(context.Request.Headers.Origin, UriKind.Absolute, out var origin)
        || !string.Equals(origin.GetLeftPart(UriPartial.Authority), expectedOrigin, StringComparison.OrdinalIgnoreCase))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    var sessionId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (sessionId is not null)
        await tokenStore.DeleteAsync(sessionId);
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.NoContent();
}).RequireAuthorization();

app.Run();

public sealed record SaveCalendarSelectionRequest(string[] CalendarIds);

public partial class Program;
