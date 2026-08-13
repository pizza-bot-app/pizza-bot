# Running a standalone backend

Pizza Bot's API server can run independently from its Electron client. This is
the supported layout for a Linux server serving macOS or Windows desktop
clients. The desktop and backend communicate only through the same HTTP/SSE
protocol used by the embedded backend.

The backend owns its data and capabilities. `PIZZA_DATA_ROOT`, provider
credentials, MCP configuration, skills, and installed plugins all live on the
server, not on a connected desktop.

Only run one API process for a given `PIZZA_DATA_ROOT`. The backend uses local
SQLite databases and is not a horizontally scalable service.

## Requirements

- Node.js 24 or newer is required to build and run the standalone artifact.
- A source checkout and npm are required only to build it.
- A deployed artifact needs Node.js, its environment, and a writable data
  directory; it does not need the repository or an `npm install`.

For source development, install and build the workspace first:

```bash
npm ci
npm run build
```

## Build the production artifact

Build `dist/backend` from the repository root:

```bash
npm run backend:bundle
npm run backend:smoke
```

The artifact contains the bundled API server, **Built-in** skills, bundled
**Plugin** packages, deduplicated plugin runtime dependencies, Linux and
build-host `better-sqlite3` prebuilds, project and third-party license
inventories, and a `start.mjs` launcher. The smoke command starts that launcher
on an ephemeral port and exercises authenticated HTTP and SSE requests.

Run it directly with:

```bash
PIZZA_DATA_ROOT="$HOME/.pizza-bot-server" \
PIZZA_HOST=127.0.0.1 \
PORT=8080 \
node dist/backend/start.mjs
```

To transfer it to another host:

```bash
tar -C dist -czf pizza-bot-backend.tgz backend
```

Extract the archive on a host with Node.js 24 and run `backend/start.mjs`. Build
the artifact from a trusted checkout: its plugins and MCP servers execute on the
backend host.

For an editable source process, use
`npx tsx apps/api-server/src/index.ts` after `npm run build`. Production services
should use the artifact launcher instead.

## Electron quickstart

This example runs an authenticated backend on the same machine as
`npm run dev`. The root dev command serves the Electron renderer from
`http://localhost:5273`, so that exact origin is allowed.

1. Build the backend once:

   ```bash
   npm run backend:bundle
   ```

2. Generate a token and start the backend in terminal A:

   ```bash
   export PIZZA_API_TOKEN="$(openssl rand -hex 32)"
   printf 'Backend token: %s\n' "$PIZZA_API_TOKEN"

   PIZZA_DATA_ROOT="$HOME/.pizza-bot-remote" \
   PORT=8081 \
   PIZZA_HOST=127.0.0.1 \
   PIZZA_ALLOWED_ORIGINS="http://localhost:5273" \
   node dist/backend/start.mjs
   ```

3. Run `npm run dev` in terminal B.

4. In Pizza Bot, select the server indicator in the lower-left status bar,
   open **Connection**, and select **Remote**.

5. Enter `http://127.0.0.1:8081` and the token printed in terminal A, then
   select **Test and connect**.

Electron remembers the selection. On the next launch it connects to the remote
backend without starting the embedded backend or its child services. Switching
back to **Embedded** starts the local backend immediately.

The saved remote token is protected with Electron `safeStorage`. The backend
still treats it as one shared bearer token with full API access.

### Verify the backend directly

`/ping` is intentionally unauthenticated:

```bash
curl -s http://127.0.0.1:8081/ping
```

The authenticated root endpoint verifies the token and API version:

```bash
curl -s \
  -H "Origin: http://localhost:5273" \
  -H "Authorization: Bearer $PIZZA_API_TOKEN" \
  http://127.0.0.1:8081/
```

A compatible backend returns:

```json
{"service":"pizza-bot","protocolVersion":1,"apiVersion":"1"}
```

## Browser UI quickstart

For local browser development, keep both processes loopback-only. The backend's
default origin allowlist includes Vite's `http://localhost:5173` origin:

```bash
# terminal A
PIZZA_DATA_ROOT="$HOME/.pizza-bot-browser" \
PORT=8081 \
node dist/backend/start.mjs

# terminal B
PIZZA_API_TARGET=http://127.0.0.1:8081 npm run dev -w @pizza-bot/web
```

Open `http://localhost:5173`. Vite proxies `/api` to the standalone backend.
This local example does not set a bearer token; the API remains bound to
`127.0.0.1`.

The Vite proxy does not inject authentication.

### Static browser deployment

Build the web workspace from the repository root:

```bash
npm run build -w @pizza-bot/web
```

Deploy the contents of `apps/web/dist`, replacing
`apps/web/dist/pizza-config.js` at deploy time:

```js
window.__PIZZA_CONFIG__ = {
  apiBase: "https://api.pizza.example",
  apiToken: "the-same-value-as-PIZZA_API_TOKEN",
};
```

Set `PIZZA_ALLOWED_ORIGINS` on the API server to the browser application's exact
origin. Serve both endpoints over TLS and configure `pizza-config.js` with
`Cache-Control: no-store`. The shared bearer token is visible to anyone who can
load the application and to scripts running in that origin, so access to the
static app must be restricted. Credentials are never accepted through URL query
parameters.

## Configure the backend

A new `PIZZA_DATA_ROOT` is intentionally empty. Conversations and embedded
desktop settings do not appear automatically.

- Configure AWS profiles and non-secret provider settings under **Settings >
  Providers**. Profiles are discovered on the backend host.
- API-key providers require the key in the backend process environment and
  persist only an environment-variable reference. Export the variable before
  starting the server or put it in `<PIZZA_DATA_ROOT>/.env.local`.
- MCP servers are configured in `<PIZZA_DATA_ROOT>/.mcp.json`. Environment
  references in that file expand from the backend process environment.
- Local-folder grants are paths on the backend host, not the connected desktop.
  The agent sees each grant read-only at `/local/<folder-id>/`; no folder,
  including the backend user's home directory, is granted by default.
- User plugins, skills, attachments, conversations, and logs belong to the
  selected server data root. Bundled **Plugin** packages and **Built-in** skills
  are included in the artifact.

Electron's provider secret store belongs to the client machine and is passed
only to its embedded backend. When Electron connects to a remote backend,
configure provider secrets on that backend.

Folder configuration over HTTP is disabled by default. To administer grants
from **Settings > Files**, start the backend with
`PIZZA_ALLOW_LOCAL_FOLDER_CONFIGURATION=1`, add or remove the required
backend-host directories, then restart without the flag. The remote UI always
accepts an absolute Linux or Windows path. To also provide a server-side picker,
set `PIZZA_LOCAL_FOLDER_BROWSE_ROOTS` to the directories the UI may browse.
Separate multiple roots with `:` on Linux/macOS or `;` on Windows:

```bash
PIZZA_ALLOW_LOCAL_FOLDER_CONFIGURATION=1 \
PIZZA_LOCAL_FOLDER_BROWSE_ROOTS="/srv/projects:/mnt/shared" \
node dist/backend/start.mjs
```

```powershell
$env:PIZZA_ALLOW_LOCAL_FOLDER_CONFIGURATION = '1'
$env:PIZZA_LOCAL_FOLDER_BROWSE_ROOTS = 'C:\Users\builder\Projects;D:\Shared'
node dist/backend/start.mjs
```

The picker lists directories only, does not follow symlinks or junctions, and
cannot leave those canonical roots. Display labels and virtual path ids are
derived from the selected directory name. While configuration is enabled,
anyone with the backend bearer token can enumerate directory names beneath the
browse roots and grant read access to any directory readable by the backend
process, except the Pizza Bot data root and its ancestors or descendants.

For example, this stores an Anthropic environment reference without sending the
secret over the API:

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $PIZZA_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"method":"api-key","values":{"apiKey":"${ANTHROPIC_API_KEY}"}}' \
  http://127.0.0.1:8081/providers/anthropic
```

A green backend connection alongside a red inference-provider status means the
connection succeeded but no usable model provider is configured on the server.
An unavailable skill usually means its required MCP server or tools are not
configured there.

## Deploy on Linux

The provided examples use this topology:

```text
Electron -> HTTPS -> Caddy -> 127.0.0.1:8080 -> Pizza Bot
```

Keep the API listener private. Caddy supplies the public TLS endpoint and sends
streaming responses without proxy buffering.

### Docker

Build the multi-stage image from the repository root:

```bash
docker build -f deploy/linux/Dockerfile -t pizza-bot-backend .
```

Finch can build the same image on macOS. Initialize its VM once, then build the
native Linux architecture or cross-build an AMD64 server image:

```bash
finch vm init
finch build -f deploy/linux/Dockerfile -t pizza-bot-backend .
finch build --platform linux/amd64 \
  -f deploy/linux/Dockerfile -t pizza-bot-backend:linux-amd64 .
```

Create a root-owned environment file and replace the token before starting the
container:

```bash
sudo install -d -m 700 /etc/pizza-bot
sudo install -m 600 deploy/linux/pizza-bot.env.example \
  /etc/pizza-bot/pizza-bot.env
sudoedit /etc/pizza-bot/pizza-bot.env
```

Publish the container only on the host loopback address for Caddy:

```bash
sudo docker volume create pizza-bot-data
sudo docker run -d \
  --name pizza-bot-backend \
  --restart unless-stopped \
  --init \
  --env-file /etc/pizza-bot/pizza-bot.env \
  --env PIZZA_HOST=0.0.0.0 \
  --publish 127.0.0.1:8080:8080 \
  --volume pizza-bot-data:/var/lib/pizza-bot \
  pizza-bot-backend
```

The image runs as an unprivileged user. Its startup fails when the container's
non-loopback listener lacks a token of at least 32 characters or an explicit
origin allowlist.

### systemd

Build and transfer `dist/backend`, then install Node.js 24 on the server. The
provided unit expects `/usr/bin/node`; edit `ExecStart` if the host installs it
elsewhere.

Create the service account and directories:

```bash
sudo useradd --system --home-dir /var/lib/pizza-bot \
  --create-home --shell /usr/sbin/nologin pizza-bot
sudo install -d -o root -g root /opt/pizza-bot/backend /etc/pizza-bot
sudo install -d -o pizza-bot -g pizza-bot -m 700 /var/lib/pizza-bot
sudo cp -a dist/backend/. /opt/pizza-bot/backend/
sudo chown -R root:root /opt/pizza-bot/backend
```

Install the unit and environment file:

```bash
sudo install -m 644 deploy/linux/pizza-bot.service \
  /etc/systemd/system/pizza-bot.service
sudo install -m 600 deploy/linux/pizza-bot.env.example \
  /etc/pizza-bot/pizza-bot.env
sudoedit /etc/pizza-bot/pizza-bot.env
```

Replace `PIZZA_API_TOKEN` with `openssl rand -hex 32` output before enabling the
service. A loopback listener cannot detect that Caddy will expose it, so the
systemd configuration does not provide the non-loopback startup guard.

Start and inspect the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pizza-bot
sudo systemctl status pizza-bot
sudo journalctl -u pizza-bot -f
```

The unit restricts writes to `/var/lib/pizza-bot`. Trusted MCP servers that must
write elsewhere need those paths added to `ReadWritePaths`; relax `ProtectHome`
as well if a server must access a path under `/home`.

### Caddy and HTTPS

Replace `pizza.example.com` in [the example Caddyfile](../deploy/linux/Caddyfile)
with a DNS name pointing at the server, then merge the site block into
`/etc/caddy/Caddyfile` and reload Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate. Its `flush_interval -1` setting
forwards SSE frames immediately. The API also emits `X-Accel-Buffering: no` for
proxies that honor that header.

Connect packaged Electron to `https://pizza.example.com`. Packaged Electron
sends `Origin: null`, so `PIZZA_ALLOWED_ORIGINS` must include `null`. A deployed
browser UI needs its exact `https://...` origin added as a comma-separated
value.

The API process itself serves plain HTTP. Desktop connections outside loopback
reject plain HTTP, and bearer tokens must never cross an unencrypted network.

### SSH tunnel alternative

For one-user access, keep the backend on `127.0.0.1` and avoid a public listener:

```bash
ssh -NT -L 8081:127.0.0.1:8080 user@server.example.com
```

Connect Electron to `http://127.0.0.1:8081`. This works with macOS and Windows
OpenSSH, satisfies Electron's loopback HTTP restriction, and encrypts traffic
without a reverse proxy. Keep bearer authentication enabled.

## Network configuration

Direct non-loopback binding is refused unless bearer authentication with a
token of at least 32 characters and an exact origin allowlist are configured:

```bash
export PIZZA_API_TOKEN="$(openssl rand -hex 32)"

PIZZA_DATA_ROOT=/srv/pizza-bot \
PIZZA_HOST=0.0.0.0 \
PORT=8080 \
PIZZA_ALLOWED_ORIGINS="null,https://app.example.com" \
node dist/backend/start.mjs
```

Use the server's actual DNS name or IP address in clients, never `0.0.0.0`.

| Client | Origin to allow |
| --- | --- |
| Packaged Electron app | `null` |
| Root `npm run dev` | `http://localhost:5273` by default |
| Standalone Vite UI | `http://localhost:5173` by default |
| Deployed browser UI | Its exact `https://...` origin |

The API has no rate limiting, account model, or per-user authorization. Do not
expose it directly to the public internet. Put it behind TLS on a VPN or trusted
private network, or use an SSH tunnel. See [SECURITY.md](../SECURITY.md).

## Operations and backups

- Run exactly one backend process per local data root. Do not share the SQLite
  directory between containers, hosts, replicas, or workers.
- Persist and back up `PIZZA_DATA_ROOT`, not the application artifact. Stop the
  service or use a SQLite-aware snapshot before copying live database files.
- Upgrade by replacing the artifact or container image, then restarting the one
  process. Keep a data backup before upgrades.
- Provider credentials and MCP environment variables must be supplied to the
  server process. They are not forwarded from remote Electron clients.
- Local-folder grants refer to backend-host paths. Restore or deploy those paths
  separately from `PIZZA_DATA_ROOT`; unavailable roots remain inaccessible.
- Preserve proxy streaming. Response buffering makes runs and thread updates
  appear stalled even when ordinary API requests work.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `401 unauthorized` | The client bearer token must exactly match `PIZZA_API_TOKEN`. |
| `403 origin_not_allowed` | Add the client's exact origin; packaged Electron uses `null`. |
| API version mismatch | Update the client and backend from compatible Pizza Bot versions. |
| Connection refused | Check the listener, firewall, container port, service, and proxy. |
| Desktop rejects the URL | Use HTTPS outside loopback, or connect through a loopback SSH tunnel. |
| Runs or sidebar updates stall | Disable reverse-proxy buffering for both SSE endpoints. |
| Backend green, provider red | Configure a model provider and credentials on the backend. |
| Skill unavailable | Configure the required server-side MCP server and tools. |
| systemd cannot write a path | Add the trusted path to `ReadWritePaths` or keep it under the data root. |
