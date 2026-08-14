# Security

Pizza Bot is a local-first application. The server, persistent application data,
and desktop-managed credentials stay on the machine by default. Prompts, model
inputs and outputs, requested attachments, and MCP tool payloads are sent to the
providers and endpoints you configure. This document describes that boundary,
the safe defaults, and the choices that weaken them.

## Network exposure

- **Loopback by default.** The api-server binds to `127.0.0.1`
  (`apps/api-server/src/index.ts`). It is not reachable from other hosts unless
  you deliberately change the bind address.
- **Non-loopback binding is gated.** Setting `PIZZA_HOST` to a non-loopback
  address is refused unless you *also* set a `PIZZA_API_TOKEN` of at least 32
  characters and `PIZZA_ALLOWED_ORIGINS`. The server throws on startup otherwise,
  so it cannot accidentally expose privileged APIs on `0.0.0.0`.
- **Bearer authentication.** When `PIZZA_API_TOKEN` is set, every request except
  `OPTIONS` preflights, the `/ping` health check, and webhook invocations must
  carry `Authorization: Bearer <token>`. The token is compared with a
  constant-time check. Loopback-only runs leave the token unset and rely on the
  bind address for isolation.
- **Origin allowlist + CORS.** Requests whose `Origin` is not in the allowlist
  are rejected with `403`. Locally the allowlist defaults to the Vite dev origins
  (`http://localhost:5173`, `http://127.0.0.1:5173`); a remote deployment must
  enumerate its origins in `PIZZA_ALLOWED_ORIGINS`.
- **No credentials in URLs.** Tokens are carried in the `Authorization` header,
  never in query parameters. Static web builds read their API base and token from
  a deploy-time `dist/pizza-config.js`, not the URL.
- **TLS for remote clients.** The API listener serves plain HTTP. Terminate TLS
  at a trusted reverse proxy or use an SSH/VPN tunnel; bearer authentication
  does not protect a token sent over an unencrypted network. Desktop clients
  reject non-loopback HTTP URLs.
- **Webhook triggers self-authenticate.** Webhook trigger endpoints stay outside
  the global bearer check and enforce their own per-trigger secret (presented as a
  `Bearer` token or an `X-Trigger-Secret` header), so a webhook can be invoked
  without handing out the server-wide token.

## Credentials and secrets

- **Provider secrets use Electron's OS-backed protection.** In the desktop app,
  model-provider API keys pass through Electron `safeStorage`, and its output is
  persisted under `<data-root>/secrets.json`
  (`apps/desktop-shell/src/secret-store.ts`). Plaintext exists while the user
  enters it and while the main process passes it to the api-server child; it is
  not returned to the renderer after storage. The desktop refuses to save a
  secret when `safeStorage.isEncryptionAvailable()` is false. On Linux,
  `safeStorage` can select the `basic_text` backend when no compatible secret
  store is available; in that configuration the value on disk is not
  meaningfully encrypted.
- **Remote backend tokens use the same protection.** A bearer token entered in
  the desktop Connection settings is encrypted with Electron `safeStorage`
  before it is written to `desktop-connection.json`. It is exposed only to the
  sandboxed renderer that needs it for authenticated API requests. Desktop
  connections outside loopback require HTTPS.
- **AWS/Bedrock credentials use the same secret boundary.** Named profiles use
  the standard AWS credential chain. Access keys and Bedrock API keys entered in
  the desktop app use `safeStorage` like other provider secrets; server-side
  configuration stores only environment-variable references.
- **Environment references stay raw on disk.** MCP server manifests keep
  `${ENV_VAR}` references literally and expand them only for a live connection.
  Literal header and environment values are also accepted and would be stored as
  plaintext, so use references for every MCP secret.
- **Logs are redacted.** The logging layer scrubs known secrets, `Bearer` tokens,
  URL credentials, and sensitive-looking assignment values before writing
  (`packages/logging/src/redact.ts`), and MCP env values are reported as
  `<redacted>` on status endpoints.

## Local data and logs

By default, durable application state lives under `<PIZZA_DATA_ROOT>` (default
`~/.pizza-bot-oss`):

- `checkpoints.sqlite` — LangGraph run checkpoints (conversation state).
- `store.sqlite` — long-term memory / key-value store.
- `app.sqlite` — threads, triggers, settings, attachments, search index.
- `attachments/` and `memories/` — attachment bytes and user memory documents.
- `skills/`, `plugins/`, `plugin-materializations/`, and `.mcp.json` — user
  capabilities, generated plugin snapshots, and MCP settings.
- `logs/` — rotated application logs.
- `secrets.json` and `desktop-connection.json` — `safeStorage`-protected desktop
  secrets and backend selection.

The data root is created with user-only POSIX permissions; databases,
attachments, MCP configuration, and logs are also restricted to user-only
modes. Other content is not encrypted beyond what your filesystem provides.
Anyone who gains access as your user can read conversations and long-term
memory, and the Linux `basic_text` fallback does not protect desktop secrets
from that user. `PIZZA_PLUGINS_DIR`, `PIZZA_SKILLS_DIR`,
`PIZZA_MEMORIES_DIR`, and `PIZZA_MCP_CONFIG` can place selected resources
elsewhere; those paths need equivalent access controls and backups.

The SQLite data root supports one backend process on local storage. Do not mount
one data root into multiple containers, replicas, or hosts. Stop the process or
use a SQLite-aware snapshot when backing up live databases.

## MCP servers and plugins are trusted code

- **MCP commands are arbitrary executables.** A stdio MCP entry is launched as a
  child process with your user's permissions. It receives the environment you
  configure, `PATH`, and allowlisted provider context such as AWS region/profile,
  so it can access those values and anything else your account can access.
- **Plugin materializers are arbitrary executables.** A plugin can opt into an
  install/startup/manual materialization hook that runs with your user's
  permissions and inherits the host environment. It can read its declared source
  roots, but the operating system does not confine it to those paths. Review the
  entrypoint before installation.
- **Generated plugin files are declarative.** Pizza Bot validates materialized
  manifests, Agent Skills, and MCP settings before activating them; there is no
  executable web-UI contribution kind. A plugin's MCP entry can still name an
  executable command, so installing that plugin also trusts the processes it
  launches.
- **Skills can direct tool use.** A skill's `SKILL.md` becomes a worker's system
  prompt and can steer the model toward its declared tools. Review skills from
  sources you don't control before installing them.

Treat installing an MCP server, a plugin, or a user skill as running code (or
directing the model to) on your machine. The ZIP import confirmation is a trust
prompt, not a sandbox. Only install sources you trust.

## Unsupported / discouraged configurations

- **Exposing the server publicly.** The gated non-loopback path exists for trusted
  private networks (e.g. a home LAN or a machine you control behind a VPN). It is
  not hardened for exposure to the public internet — there is no rate limiting,
  account model, or per-user authorization beyond the single shared bearer token.
  Put it behind a reverse proxy / VPN if you must reach it remotely.
- **The packaged desktop renderer has a `null` origin.** A directly connected
  remote backend must allow `null` in `PIZZA_ALLOWED_ORIGINS`. Because other
  local-file pages can also have that origin, use this only for a backend on a
  trusted private network and retain bearer authentication.
- **Sharing a token across users.** The bearer token is a single shared secret,
  not a per-user credential. Anyone holding it has full API access.
- **Committing secrets.** Do not put API tokens or provider keys into `.env`
  files you commit, into MCP manifests, or into URLs. Use the desktop Providers
  settings with a secure `safeStorage` backend, or shell-exported environment
  variables.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a public
issue. Use GitHub's **"Report a vulnerability"** flow (Security → Advisories) on
this repository, which keeps the report confidential until a fix is available.
Include reproduction steps and the affected version/commit. We will acknowledge
the report and coordinate a fix and disclosure timeline with you.
