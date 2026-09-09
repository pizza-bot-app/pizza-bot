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
- The bundled Browser Automation Plugin needs Chrome, Edge, or Chromium on the
  backend host. The default container image omits a browser; the backend reports
  the plugin as unavailable without affecting its other capabilities.

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

The browser app can be hosted separately from the API: build it with
`npm run build -w @pizza-bot/web`, deploy `apps/web/dist`, and replace
`pizza-config.js` with an `apiBase` and `apiToken` for the API's origin, which
must also appear in that server's `PIZZA_ALLOWED_ORIGINS`. Serve it with
`Cache-Control: no-store`.

The container serves both on one origin and needs none of that, so prefer it.
Either way the bearer token is readable by anyone who can load the application,
so restrict access to it. Credentials are never accepted through URL query
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
  The agent sees each grant at `/local/<folder-id>/`. Grants default to
  read-only and can explicitly allow writes; no folder, including the backend
  user's home directory, is granted by default.
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
browse roots and grant read or write access to directories accessible by the
backend process. Grants that overlap the Pizza Bot data root require an explicit
acknowledgement because they can expose or modify private application state.

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

Every example puts a TLS endpoint in front of a listener that is not otherwise
reachable:

```text
Electron or browser -> HTTPS -> reverse proxy -> Pizza Bot
```

A Kubernetes deployment uses its Ingress and a `ClusterIP` service; a single
host publishes the container on loopback behind a TLS proxy. Whichever fronts
it must stream responses without proxy buffering — the API emits
`X-Accel-Buffering: no` for proxies that honor it.

### Docker

Build the multi-stage image from the repository root:

```bash
docker build -t pizza-bot-backend .
```

The default image omits Chromium. To include it for the Browser Automation
Plugin, build the optional target:

```bash
docker build --target runtime-with-browser \
  -t pizza-bot-backend-browser .
```

Finch can build the same image on macOS. Initialize its VM once, then build the
native Linux architecture or cross-build an AMD64 server image:

```bash
finch vm init
finch build -t pizza-bot-backend .
finch build --platform linux/amd64 \
  -t pizza-bot-backend:linux-amd64 .
```

The image serves the browser app and the API on one port: a browser navigating
to `/` receives the app, every other path stays the API, and non-browser clients
still read the service identity from `/`. `PIZZA_WEB_DIR` points at the bundled
app; unset it for an API-only container.

The server generates `/pizza-config.js` per request, so one image works at any
origin without a rebuild. That response carries `PIZZA_API_TOKEN`, so every
client that can reach the listener can read the token. Restrict access to the
port, not to the application.

Put the token and provider credentials in a root-owned environment file.
[`.env.example`](../.env.example) documents every setting the server reads:

```bash
sudo install -d -m 700 /etc/pizza-bot
sudo install -m 600 /dev/null /etc/pizza-bot/pizza-bot.env
sudoedit /etc/pizza-bot/pizza-bot.env
```

Publish the container on loopback only, and let a TLS proxy reach it there:

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

### Host data and credentials in a container

The image runs as UID 10001, so bind-mounting a data root that a host account
owns needs `--user "$(id -u):$(id -g)"`. Run the container as the owning
account rather than relaxing the directory's permissions.

That UID then has no entry in the container's `/etc/passwd`, so set `HOME`
explicitly: the server resolves an external plugins directory from `homedir()`
at startup. Point `HOME` somewhere other than `PIZZA_DATA_ROOT` if you also
mount credential directories under it, so they do not appear inside the data
root on the host.

Provider credentials that a host CLI wrote are not visible to the container. The
AWS SDK reads its configuration and SSO cache from `$HOME/.aws`, so a Bedrock
backend needs that directory mounted:

```bash
docker run -d \
  --user "$(id -u):$(id -g)" \
  --env HOME=/home/pizza \
  --env PIZZA_DATA_ROOT=/data \
  --env PIZZA_HOST=0.0.0.0 \
  --env-file /etc/pizza-bot/pizza-bot.env \
  --publish 127.0.0.1:8080:8080 \
  --volume "$HOME/.pizza-bot-oss:/data" \
  --volume "$HOME/.aws:/home/pizza/.aws:ro" \
  pizza-bot-backend
```

Values passed with `--env` override the same names in `--env-file`.

Only one API process may run against a data root at a time. Stop a host service
before starting a container against the same directory, and back the directory
up first. Automations stored there run as soon as the server starts.

### Compose

[`docker-compose.yml`](../docker-compose.yml) runs the same image with a named
data volume and a loopback-only published port, reading provider credentials
from an optional `.env` beside it. It pulls the published image, which is
`linux/amd64` only:

```bash
PIZZA_API_TOKEN="$(openssl rand -hex 32)" \
PIZZA_ALLOWED_ORIGINS=https://pizza.example.com \
docker compose up --detach
```

Add `--build` on an arm64 host, or to run code that has not been released. That
builds from this checkout and tags the result as the `image:` reference, so no pull
happens; repeat it after every `git pull`, or Compose reuses the image it built
before.

### Registry images

A release publishes `ghcr.io/pizza-bot-app/pizza-bot`, tagged `latest`, the release
version, `<major>.<minor>`, and `sha-<commit>`. Only a release publishes, so
`latest` is the newest release rather than the tip of `main`:

```bash
docker pull ghcr.io/pizza-bot-app/pizza-bot:1.0.0
```

Pin a version for a deployment. `latest` moves under you on the next release, and
nothing coordinates that with a restart.

**The image is `linux/amd64` only.** An arm64 host needs
`--platform linux/amd64`, which runs it emulated and slower, or should build the
image natively instead — [Docker](#docker) above builds for the host architecture
and needs no registry.

Build from a checkout to run code that has not been released, for an architecture
the registry does not carry, or to keep the image in a registry you control:

```bash
docker build -t registry.example.com/pizza-bot:1.0.0 .
docker push registry.example.com/pizza-bot:1.0.0
```

Tag it with the release you built from — `git describe --tags` — so a deployed
container traces back to a commit.

### Kubernetes

Beyond the image reference — and a pull secret, if it comes from a registry that
needs one — a deployment needs:

- `PIZZA_HOST=0.0.0.0`, so the listener accepts cluster traffic. That binding
  requires `PIZZA_API_TOKEN` of at least 32 characters and
  `PIZZA_ALLOWED_ORIGINS` naming the external origin the browser loads.
- `PIZZA_DATA_ROOT` on a `ReadWriteOnce` volume, with one replica and the
  `Recreate` strategy. The backend owns local SQLite databases and does not
  scale horizontally.
- A volume the unprivileged user can write. Set `securityContext.fsGroup: 10001`
  on the pod unless the provisioner already creates world-writable directories.
- Provider credentials the pod can obtain without a person present. An AWS SSO
  profile is not one: its cached token expires and is refreshed by an
  interactive login, so a restarted pod loses access to Bedrock. Use credentials
  the pod can hold — an API-key provider, or an IAM principal scoped to
  `bedrock:InvokeModel*` whose keys live in the deployment's Secret.

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
| Playwright reports `browser_not_found` | Install a browser where the backend runs, or set `PIZZA_PLAYWRIGHT_BROWSER_PATH`; a host browser is not visible inside a container. |
| Skill unavailable | Configure the required server-side MCP server and tools. |
| Container cannot write the data root | Run it as the account that owns the directory, or set `fsGroup` on the pod. |
