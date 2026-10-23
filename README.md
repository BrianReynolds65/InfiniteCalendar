# Daybook

A Vite + React calendar with an endlessly scrolling, week-per-row view. It starts with sample events and can connect to multiple Google Calendars through an ASP.NET Core backend.

## Run locally

Install Node.js and the .NET 9 SDK. Configure Google OAuth as described below, then run the backend and frontend in separate terminals:

```sh
npm install
dotnet run --project server\InfiniteCalendar.Api.csproj
```

```sh
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`.

## Configure Google Calendar

1. In Google Cloud Console, create a project and enable the Google Calendar API.
2. Configure the OAuth audience for your account or intended users:
   - For a Google Workspace organization, choose **Internal** if only people in that organization will use the app.
   - For **External** audience while the app is in **Testing**, add every account that needs access under **Test users**. Sign in with one of those exact accounts when connecting.
   - For general access outside testing, publish the app and complete Google's verification for the `calendar.events` and `calendar.calendarlist.readonly` scopes. Until verification is complete, Google may block users who are not listed as test users.
3. Create an OAuth client ID of type **Web application**. Add `http://localhost:5173` to **Authorized JavaScript origins** and `http://localhost:5173/auth/callback` to **Authorized redirect URIs**.
4. Store the client ID and secret as .NET user secrets (replace the placeholders with the values from Google Cloud Console):

   ```sh
   dotnet user-secrets set "Google:ClientId" "YOUR_CLIENT_ID" --project server\InfiniteCalendar.Api.csproj
   dotnet user-secrets set "Google:ClientSecret" "YOUR_CLIENT_SECRET" --project server\InfiniteCalendar.Api.csproj
   ```

5. Start both servers as described in [Run locally](#run-locally), choose **Connect Google**, authorize calendar event read/write access, and pick which calendars to show.

The local OAuth redirect assumes Vite is running at `http://localhost:5173`. If you use another origin, set `Google:FrontendOrigin` to that origin and register its `/auth/callback` URL in Google Cloud Console. Vite uses strict port mode so it will not silently start on a different port.

If Google shows **“Access blocked”**, check that the signed-in account is an allowed test user or belongs to the app's internal organization. Also confirm that the OAuth client and consent screen are in the same Cloud project. App verification and audience settings are managed in Google Cloud Console.

Google may expire refresh tokens after seven days when an External OAuth app remains in Testing and requests non-basic scopes such as Calendar read access. The backend cannot override that policy; publish the app and complete any required verification for longer-lived access.

## Sessions and deployment

The backend stores Google refresh tokens and calendar selections encrypted with ASP.NET Core Data Protection; the browser receives only a persistent, HTTP-only session cookie. Calendar selections are restored on refresh and saved when changed. Disconnecting clears the session and its saved selection. The backend's data directory defaults to `%LOCALAPPDATA%\InfiniteCalendar` on Windows (or the operating system's local application-data directory), containing both the encrypted sessions and Data Protection keys. Restrict access to this directory and preserve it across backend restarts, or users will need to connect again.

For production, serve the app and backend over HTTPS, set `Google:FrontendOrigin` to the public app origin, register that origin's `/auth/callback` URL as the OAuth redirect URI, and use a persistent, access-controlled data directory. Protect the Data Protection key ring with a production key-management service before deploying to shared or untrusted infrastructure.

The app requests `calendar.events` to read and edit events, and `calendar.calendarlist.readonly` to list your calendars. The Google client secret and refresh tokens never go to the frontend. If you connected before these scopes were requested, disconnect and reconnect, then approve both permissions. Clicking a blank day opens the event editor (timed by default, with an all-day option); new events go to the first selected calendar. Clicking an event opens it for editing. While connected, the frontend checks for calendar changes every 60 seconds; changing the selected calendars or visible date range triggers an immediate refresh. Polls run sequentially to avoid overlapping requests.

## Build

```sh
npm run build
```