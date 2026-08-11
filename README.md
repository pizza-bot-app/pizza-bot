# Pizza Bot OSS

Pizza Bot is an email-like inbox for long-running AI work. Start or schedule a
task, return to your day, and let run results you are not viewing collect in
**Unread** while runs paused for a decision collect in **Action**. Agents keep
working when you navigate away or disconnect; the api-server process must remain
running.

The stateful runtime is built on DeepAgents / LangGraph, with the same React
frontend and [AI Elements-derived](https://elements.ai-sdk.dev) components in
Electron and the browser. Every client — web, desktop, and the terminal CLI —
speaks HTTP/SSE to a running server.

Pizza Bot was developed at Amazon and is released under the Apache 2.0 license.

## What it gives you

- **An asynchronous work inbox.** Switch between conversations without stopping
  their runs. Use Unread for completed work and Action for durable human approval
  requests, instead of monitoring a chat window.
- **Durable background work.** Checkpointed runs survive client disconnects;
  cron and webhook triggers can start work without an open conversation.
- **One stateful runtime, coupled by design.** DeepAgents/LangGraph is the sole
  implementation, reached through the `createPizzaBotAgent` factory; Pizza Bot
  is checkpointer-backed (resumable, time-travelable). There's no `RuntimeProvider`
  abstraction — see [`packages/RUNTIMES.md`](packages/RUNTIMES.md).
- **The native LangGraph protocol as the wire.** The runtime emits
  `@langchain/protocol` `ProtocolEvent` frames via `streamEvents(v3)`; every
  frontend consumes them through the `@langchain/langgraph-sdk`
  `Client`/`ThreadStream`/`StreamController`. The seam is the **protocol + SDK
  projection** boundary — no normalized union and no React coupling.
- **Native HITL, checkpointing, subagents, and long-term memory** via DeepAgents,
  surfaced through the protocol stream and AI Elements-derived
  `Confirmation`/`Tool` components.
- **Any supported model provider.** Amazon Bedrock, Anthropic, Google Gemini,
  OpenAI, OpenRouter, and Ollama ship as peer adapters behind the same
  provider-agnostic model seam. Configure them from the in-app Settings screen;
  desktop-entered secrets go to the OS keychain, while server configuration
  persists only environment-variable references.
- **Skills as the capability seam.** Drop a `SKILL.md` under
  `~/.pizza-bot-oss/skills/<id>/` and
  the Pizza Bot orchestrator gains a tool-scoped subagent it can delegate to via
  the `task` tool. The root routes from each skill's name and description; the
  worker receives the full `SKILL.md` body and declared tools. Pizza Bot is the
  only conversation agent; skills are how you extend it.
- **One SDK, HTTP wire.** Every client — web, desktop, and the terminal CLI —
  speaks HTTP/SSE to the api-server over the SDK's `HttpAgentServerAdapter`,
  surfaced as the same SDK `ThreadStream` projection.
- **Declarative plugins** — MCP servers and skills, a subset of the Claude Code
  plugin format.
- **Durable triggers** — cron / webhook, with missed-run recovery on startup, so a
  schedule missed while the machine was asleep fires once after wake or restart.
- **Native desktop notifications** — independently configurable alerts for
  finished runs and threads waiting for user input.

## Docs

- **[Architecture](docs/ARCHITECTURE.md)** — read this first. The seams, the event
  model, the runtime, persistence, transports, plugins, and the design decisions
  behind them.
- **[Runtimes](packages/RUNTIMES.md)** — how the LangGraph runtime is wired.
- **[Contributing](CONTRIBUTING.md)** — dev setup, CI checks, and the
  layering discipline.
- **[Security](SECURITY.md)** — network defaults, credential handling, MCP/plugin
  trust, and how to report a vulnerability.
- **[Standalone backend](docs/STANDALONE_BACKEND.md)** — production bundle,
  Docker, systemd, Caddy, and remote Electron setup.
- **[Logging](docs/LOGGING.md)** — diagnostics location, retention, and redaction.

## Layout

```
apps/        api-server (Hono) · cli · desktop-shell (Electron) · web (React + AI Elements-derived components)
packages/    core · runtime-langgraph · inference-providers · plugin-sdk · storage · logging
plugins/     example-mcp-status (reference plugin)
skills/      optional built-in SKILL.md capability catalog
tests/       langgraph-compat (the conformance safety net)
```

`core` is **nearly pure** (no `node:*`, DOM, `deepagents`, or `@langchain/langgraph`)
but may reference `@langchain/core` model/agent types (the app is coupled to
LangGraph by design); it also owns the pure protocol/wire types. `apps/web` imports
no runtime and no model binding — only the transport SDK and the pure `core` types.
DeepAgents and runtime graph construction are isolated to the production
`runtime-langgraph` package; the conformance workspace imports DeepAgents only
to pin its public API. If DeepAgents' API churns, the runtime blast radius is
one package.

## Develop

Application processes write structured, redacted, rotating diagnostics under
`<PIZZA_DATA_ROOT>/logs`. See [docs/LOGGING.md](docs/LOGGING.md) for retention,
privacy rules, the in-app Logs view, and the developer API.
Node.js 24 or newer is required.

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Workspace builds replace their own `dist/` directories before emitting, which
prevents deleted or renamed sources from leaving stale runtime files behind.
`npm run clean` removes generated workspace outputs while preserving
`node_modules` and the root Turbo cache. `npm run clean:all` removes those too
and must be followed by `npm install`.

> **Windows:** `npm install` needs the Visual Studio C++ build tools:
>
> ```powershell
> winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
> ```
>
> npm runs `better-sqlite3`'s implicit `node-gyp rebuild`, and node-gyp fails at
> *configure* if no MSVC toolchain is present — before it can evaluate the
> `binding.gyp` guard that would have skipped the compile as unnecessary. The
> compiled output is then unused: the loader prefers `prebuilds/win32-x64.node`.
> To install without a toolchain, use `npm install --ignore-scripts` (Electron 43
> has no `postinstall` — it downloads its binary lazily on first launch).

> The `--concurrency=2` cap in `npm test` is intentional: uncapped, the parallel
> vitest+esbuild workers can exhaust file descriptors/memory and fail en masse.
> For a tight loop, run one workspace: `npx vitest run --dir packages/<pkg>`.

A running api-server needs access to at least one model provider; HTTP clients
do not. Configure Amazon Bedrock, Anthropic, Google Gemini, OpenAI, OpenRouter,
or Ollama in **Settings > Providers**. Bedrock accepts an AWS profile, AWS
access keys, or a Bedrock API key, with an optional region override; otherwise
`AWS_REGION` or `us-west-2` is used. Select a model with
`PIZZA_MODEL=<provider>:<id>`. Desktop-entered secrets go to the OS keychain;
server configuration persists only environment-variable references.

> `npm run dev` starts the Vite web server (on `5273`, offset from the `5173`
> default so it coexists with another instance) and the desktop shell. The shell
> forks and supervises its own api-server exactly as the packaged app does — so
> `npm run dev` runs the production boot path, not a dev-only shortcut. Set
> `PIZZA_WEB_PORT` to move the web port. The individual entrypoints below still
> work for driving pieces in isolation.

## MCP servers

To bring your own MCP server, create it in the **MCP Servers** UI or add its
Claude Code-compatible entry to `<PIZZA_DATA_ROOT>/.mcp.json`. The default data
root is `~/.pizza-bot-oss`. Keep credentials out of that file by putting them in
`<PIZZA_DATA_ROOT>/.env` (or `.env.local`) and referencing them as `${ENV_VAR}`
in the MCP entry. The api-server loads those files at startup without overriding
variables already exported by its parent process; restart Pizza Bot or the
api-server after changing them.

String fields in `.mcp.json` expand environment references at connect time. Set
`"enabled": false` on an entry to keep it configured without launching it.
Startup runs at most three connections at a time and gives each attempt 20
seconds by default; override those limits with `PIZZA_MCP_STARTUP_CONCURRENCY`
and `PIZZA_MCP_CONNECTION_TIMEOUT_MS`.

### Shipped MCP Status example

The bundled `example-mcp-status` plugin demonstrates a local stdio MCP server
paired with a skill. Its plugin-owned `.mcp.json` uses the same server shape:

```json
{
  "mcpServers": {
    "mcp-status": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/server.js"]
    }
  }
}
```

Shipped plugins load this configuration automatically. User-managed servers
belong in `<PIZZA_DATA_ROOT>/.mcp.json`.

### MCP-backed skills

The api-server loads built-in skills from the repo/package `skills/` directory
and user skills from `<data-root>/skills` (`~/.pizza-bot-oss/skills` by default).
User skills override a built-in or plugin skill with the same id. The
orchestrator exposes each ready skill as a delegatable, tool-scoped subagent.
Skill names and descriptions are routing metadata, so descriptions should state
the concrete tasks the worker handles and distinguish it from adjacent skills.

Skills with unresolved MCP dependencies remain visible as loading or
unavailable, but are not exposed to the orchestrator as callable workers.
Ordinary messages can run while MCP servers connect; newly ready skills become
available on the next turn. Override the user directory with `PIZZA_SKILLS_DIR`,
the shipped directory with `PIZZA_BUILTIN_SKILLS_DIR`, and plugins with
`PIZZA_PLUGINS_DIR`.

Skills and MCP servers from every source can be disabled from their detail
screens without changing the source plugin or skill bundle. A skill enters the
runtime only when all of its declared MCP servers are enabled: enable the servers
before explicitly enabling the skill, and disable dependent skills before
disabling or deleting a server. Missing configuration and connection failures
affect readiness, not the saved enablement choice, so skills recover when their
dependencies return.

## Running

The source commands below assume `npm install` and `npm run build` have completed
successfully in the current checkout.

### 1. CLI — the simplest "it's alive"

The CLI is a thin client: start a server, then point the shell at it.

```bash
PORT=8080 npx tsx apps/api-server/src/index.ts   # terminal A — the server
npm run shell                                    # terminal B — interactive terminal chat
npm run shell -- "one-shot prompt"               # non-interactive single turn
```

Streams live model output from the server (checkpoints + HITL). REPL commands:
`/reset`, `/help`, `/exit`. The server URL defaults to `http://localhost:8080`;
override it with `PIZZA_REMOTE_URL` (or `PIZZA_API_URL`), and pass
`PIZZA_API_TOKEN` when the server requires bearer auth.
The CLI never loads a runtime or local agent configuration itself. The packaged
`pizza` executable is the same remote client; build it with
`npm run build -w @pizza-bot/cli` before invoking `./node_modules/.bin/pizza`.

### 2. Web app — server + UI

```bash
npm run dev          # Vite web (:5273) + the desktop shell (forks its own server)
```

`npm run dev` runs the full desktop app the way it ships (§3) — the shell forks
its own api-server — with the UI served from Vite so it hot-reloads. To develop
the **browser** UI against a standalone backend instead, run the two halves by
hand:

```bash
# terminal A — the backend (durable SqliteSaver harness)
PORT=8080 npx tsx apps/api-server/src/index.ts

# terminal B — the React + AI Elements UI (Vite proxies /api -> :8080)
npm run dev -w @pizza-bot/web          # then open http://localhost:5173
```

See **[Running a standalone backend](docs/STANDALONE_BACKEND.md)** for an
isolated data directory, authenticated Electron connections, non-default API
ports, and remote-host deployment.

The UI talks to the server over HTTP/SSE only, via the `@langchain/langgraph-sdk`
`HttpAgentServerAdapter`. To require confirmation for an MCP tool, declare
`interruptOn` for that tool in the skill's `SKILL.md` frontmatter; the allowed
decisions drive the AI Elements `Confirmation` flow.

For a static browser deployment, build the web workspace and replace
`dist/pizza-config.js` at deploy time:

```js
window.__PIZZA_CONFIG__ = {
  apiBase: "https://api.pizza.example",
  apiToken: "the-same-value-as-PIZZA_API_TOKEN",
};
```

Set `PIZZA_ALLOWED_ORIGINS` on the API server to the browser application's exact
origin. Serve both endpoints over TLS and configure `pizza-config.js` with
`Cache-Control: no-store`; the shared bearer token is visible to anyone who can
load the application, so access to the static app must be restricted by the
deployment. Credentials are never accepted through URL query parameters.

> Run the server with `npx tsx apps/api-server/src/index.ts` as shown — that's the
> supported dev command.

### 3. Desktop app (Electron) — standalone, launches its own server

The `.app` is a build artifact (not checked in), so **build it first, then open
it** — and rebuild after pulling changes, since the checked-out source may be
newer than a stale `.app`:

```bash
# macOS
npm run desktop:package                                                      # 1. (re)build the .app
open "apps/desktop-shell/out/Pizza Bot OSS-darwin-arm64/Pizza Bot OSS.app"   # 2. run the built app

# Windows
npm run desktop:package                                                      # 1. (re)build the app
"apps/desktop-shell/out/Pizza Bot OSS-win32-x64/pizza-bot-oss.exe"           # 2. run the built app
```

`npm run desktop:package` produces the unpacked app; `npm run desktop:make` builds
installers (DMG/ZIP on macOS, Squirrel on Windows, deb/rpm on Linux). Packaging
needs no compiler toolchain — the sole native dep (`better-sqlite3`) runs on
N-API and ships prebuilt binaries. Desktop packaging requires Node 24; on macOS
the root scripts use Homebrew's `node@24` automatically when it is installed.
Electron Forge can hang during extraction on Node 26 (see the shell README).
The Windows installer creates and removes
Start Menu and Desktop shortcuts; it is unsigned, so SmartScreen warns on
download.

To run it from source in dev, use `npm run dev` (§2): it starts Vite and the
shell, and the shell forks its own api-server just like the packaged app. For
packaging details (signing and native rebuild) see
**[apps/desktop-shell/README.md](apps/desktop-shell/README.md)**.

The server indicator in the lower-left status bar opens **Settings →
Connection**. Desktop users can switch between the embedded backend and a
remote Pizza Bot backend without restarting the app. A remote URL and optional
bearer token are stored by the Electron shell; the token is encrypted with the
OS keychain. When remote mode is selected at startup, the local api-server and
its child services are not launched.

`PIZZA_API_BASE` and `PIZZA_API_TOKEN` remain available for managed or
development launches. When `PIZZA_API_BASE` is set, it overrides the saved
desktop selection and the Connection settings are read-only.

For the complete separate-backend quickstart, including provider credentials,
MCP configuration, and troubleshooting, see
**[Running a standalone backend](docs/STANDALONE_BACKEND.md)**.

### 4. Standalone or remote backend

Build the self-contained backend artifact and run it with its own data
directory:

```bash
npm run backend:bundle

PIZZA_DATA_ROOT="$HOME/.pizza-bot-remote" \
PORT=8081 \
PIZZA_ALLOWED_ORIGINS="http://localhost:5273" \
node dist/backend/start.mjs
```

The CLI (§1) can point at it with
`PIZZA_REMOTE_URL=http://127.0.0.1:8081 npm run shell`. Electron can select it
under **Settings > Connection**. See
**[Running a standalone backend](docs/STANDALONE_BACKEND.md)** for the
authenticated command, browser workflow, Docker image, systemd/Caddy examples,
HTTPS requirements, SSH tunneling, and Linux operations.

## Security & data

- **Local-first, loopback by default.** The api-server binds to `127.0.0.1`.
  Remote binding requires `PIZZA_HOST`, a `PIZZA_API_TOKEN` of at least 32
  characters (bearer auth), and `PIZZA_ALLOWED_ORIGINS` together, so it can't
  accidentally expose privileged APIs. Desktop connections outside loopback
  must use HTTPS. Credentials are never accepted through URL query parameters.
- **Persistent application state stays local by default.** Threads, checkpoints,
  long-term memory, attachments, and logs live under `<PIZZA_DATA_ROOT>`
  (`~/.pizza-bot-oss` by default). Prompts, model inputs and outputs, attachments
  included in requests, and MCP tool payloads are sent to the providers and
  endpoints you configure.
- **MCP servers and plugins are trusted.** Plugins are declarative, but their MCP
  entries can launch arbitrary child-process commands with your user account's
  permissions and configured environment. Only install plugins and servers you
  trust.

See **[SECURITY.md](SECURITY.md)** for the full model and how to report a
vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, CI checks, and the
layering discipline that keeps the runtime seam clean.

## License

[Apache-2.0](LICENSE).
