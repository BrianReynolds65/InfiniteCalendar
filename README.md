# Daybook

A Vite + React calendar with an endlessly scrolling, week-per-row view. It connects to multiple Google Calendars and Google Tasks through an ASP.NET Core backend.

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
   - For general access outside testing, publish the app and complete Google's verification for the `calendar.events`, `calendar.calendarlist.readonly`, and `tasks` scopes. Until verification is complete, Google may block users who are not listed as test users.
3. Create an OAuth client ID of type **Web application**. Add `http://localhost:5173` to **Authorized JavaScript origins** and `http://localhost:5173/auth/callback` to **Authorized redirect URIs**.
4. Store the client ID and secret as .NET user secrets (replace the placeholders with the values from Google Cloud Console):

   ```sh
   dotnet user-secrets set "Google:ClientId" "YOUR_CLIENT_ID" --project server\InfiniteCalendar.Api.csproj
   dotnet user-secrets set "Google:ClientSecret" "YOUR_CLIENT_SECRET" --project server\InfiniteCalendar.Api.csproj
   ```

5. Enable the Google Tasks API in the Cloud project. Start both servers as described in [Run locally](#run-locally), choose **Connect Google**, authorize calendar event and Google Tasks read/write access, then choose which calendars and task lists to show.

The local OAuth redirect assumes Vite is running at `http://localhost:5173`. If you use another origin, set `Google:FrontendOrigin` to that origin and register its `/auth/callback` URL in Google Cloud Console. Vite uses strict port mode so it will not silently start on a different port.

If Google shows **“Access blocked”**, check that the signed-in account is an allowed test user or belongs to the app's internal organization. Also confirm that the OAuth client and consent screen are in the same Cloud project. App verification and audience settings are managed in Google Cloud Console.

Google may expire refresh tokens after seven days when an External OAuth app remains in Testing and requests non-basic scopes such as Calendar read access. The backend cannot override that policy; publish the app and complete any required verification for longer-lived access.

## Sessions and deployment

The backend stores Google refresh tokens, calendar selections, and task-list selections encrypted with ASP.NET Core Data Protection. A persistent, HTTP-only browser cookie keeps selections associated with the browser independently of the Google authorization session, so they are restored after backend restarts and Google reauthorization. Disconnecting explicitly clears the session and its saved selections. The backend's data directory defaults to `%LOCALAPPDATA%\InfiniteCalendar` on Windows (or the operating system's local application-data directory), containing both the encrypted sessions and Data Protection keys. Restrict access to this directory and preserve it across backend restarts, or users will need to connect again.

For production, serve the app and backend over HTTPS, set `Google:FrontendOrigin` to the public app origin, register that origin's `/auth/callback` URL as the OAuth redirect URI, and use a persistent, access-controlled data directory. Protect the Data Protection key ring with a production key-management service before deploying to shared or untrusted infrastructure.

### Run the UI and backend in Docker

The backend runs in Docker, and the built frontend is served directly by your existing HTTPS reverse-proxy container from the project's `dist` directory. The reverse proxy forwards `/api/` and `/auth/` to the backend container at `api:8080`. The API port is not published on the host. Google refresh tokens, selections, and Data Protection keys persist in the `infinitecalendar_data` named volume mounted at `/data`.

Docker must be running on the Linux server where you want the containers to run. The source code and `docker-compose.yml` must be present on that server because Compose builds the images there.

Build the frontend locally from the project root. This produces static files in `dist/`; they run on Linux unchanged:

```powershell
npm run build
```

Get the backend files and built frontend onto the Linux server using either a Git remote or a direct copy:

- If the latest changes are pushed to a Git remote, connect to the server and clone the repository (or pull the branch with the Docker files).
- From Windows PowerShell, copy the backend source, Compose configuration, example environment file, and built `dist` folder to your home directory on the Linux server. Replace `user@linux-server` with your SSH login and hostname:

  ```powershell
  ssh user@linux-server "mkdir -p infinitecalendar-upload"
  scp -r .\server .\docker-compose.yml .\.env.example .\dist user@linux-server:infinitecalendar-upload/
  ```

  If `/opt/infinitecalendar` is root-owned, `scp` cannot write there because it runs as your normal SSH user. After the transfer, connect to the server and copy the files into `/opt` with `sudo`:

  ```bash
  ssh user@linux-server
  sudo mkdir -p /opt/infinitecalendar
  sudo cp -a ~/infinitecalendar-upload/. /opt/infinitecalendar/
  sudo chown -R "$USER":"$USER" /opt/infinitecalendar
  ```

  Do not copy your local `.env` file; enter the credentials on the server instead. Only the backend is built on the Linux host; the frontend is already built locally as static files.

On the Linux server, enter the project directory, create `.env`, and edit it:

```bash
cd /opt/infinitecalendar
cp .env.example .env
nano .env
```

Put your Google OAuth credentials and public app origin in `.env`:

```dotenv
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_FRONTEND_ORIGIN=https://calendar.breynolds.org
```

On the Linux server, build and start the backend container:

```bash
docker compose up -d --build api
docker compose ps
docker compose logs -f api
```

Attach your existing HTTPS reverse-proxy service to the backend's Docker network, and mount the built frontend directory into it:

```yaml
services:
  reverse-proxy:
    volumes:
      - /opt/infinitecalendar/dist:/usr/share/nginx/html:ro
    networks:
      - default
      - calendar_proxy

networks:
  calendar_proxy:
    external: true
    name: calendar-proxy
```

In the HTTPS virtual host for `calendar.breynolds.org`, set the document root to `/usr/share/nginx/html`. Serve frontend routes from that directory, and proxy `/api/` and `/auth/` to the backend container:

```nginx
root /usr/share/nginx/html;
index index.html;

location /api/ {
      proxy_pass http://api:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
}

location /auth/ {
      proxy_pass http://api:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
}

location / {
      try_files $uri $uri/ /index.html;
}
```

This keeps the browser on the same origin, `https://calendar.breynolds.org`. In Google Cloud Console, add that origin as an authorized JavaScript origin and `https://calendar.breynolds.org/auth/callback` as an authorized redirect URI. Do not publish the API port publicly; keep access on the Docker network behind the HTTPS reverse proxy.

The named volume survives container replacement and normal restarts. Back it up, because it includes the Data Protection keys required to decrypt stored sessions. If migrating from a local backend, copy its existing data directory into `/data` before starting the container to preserve current sessions; otherwise users can reconnect to create new sessions.

To deploy later UI changes, run `npm run build` locally, copy the updated `dist` folder to the server, and reload Nginx if required. For backend changes, copy or pull the updated `server` directory and run `docker compose up -d --build api` from `/opt/infinitecalendar`. Compose replaces the API container while keeping the named data volume and server-side `.env` file.

The app requests `calendar.events` to read, edit, and delete events, `calendar.calendarlist.readonly` to list calendars, and `tasks` to read and update task lists and tasks. The Google client secret and refresh tokens never go to the frontend. If you connected before these scopes were requested, disconnect and reconnect, then approve all three permissions. Clicking a blank day opens the event editor (timed by default, with an all-day option); new events go to the first selected calendar. Clicking an event opens it for editing. The editor can delete an event after confirmation; for recurring events, choose whether to delete just that occurrence or the entire series. While connected, drag a single-day event to another day to move it; its duration and time are preserved. Multi-day events are not draggable. Selected Google Tasks lists appear in the bottom 20% of the calendar view; add tasks with the plus button, edit by selecting a task, and complete or reopen a task with its check control. Calendar events and tasks refresh every 60 seconds; changing calendar or task-list selections triggers an immediate refresh.

### Install on Android

The site includes a web app manifest and can be installed from Chrome as a standalone app. After deploying the latest frontend over HTTPS, remove any existing home-screen shortcut, open the site in Chrome, choose **Install app** from the menu, then launch it from the new app icon. Android's system status/navigation bars may still appear. Use Android app pinning or managed-device lock task mode if the tablet should stay in the calendar.

## Build

```sh
npm run build
```