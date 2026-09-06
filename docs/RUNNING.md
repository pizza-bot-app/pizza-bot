# Running from source

Pizza Bot requires Node.js 24 or newer. Run these commands from the repository
root before starting an application entrypoint:

```bash
npm install
npm run build
```

A running backend needs access to at least one model provider. Configure Amazon
Bedrock, Anthropic, Google Gemini, OpenAI, OpenRouter, or Ollama under
**Settings > Providers**. Desktop-managed secrets are protected with Electron
`safeStorage`; a standalone server stores environment-variable references
rather than secret values.

## Desktop development

The root development command starts Vite on port `5273` and launches Electron.
Electron forks and supervises its own api-server, matching the packaged
application's process model:

```bash
npm run dev
```

The `predev` hook runs `npm run browser:install` so the bundled Playwright
Plugin has its exact Chrome for Testing revision when no supported system
browser is installed. The command is idempotent, but a cold cache downloads the
browser and requires network access. Use the workspace-specific commands below
when working without the desktop or browser-automation plugin.

Set `PIZZA_WEB_PORT` to use another Vite port. Use a separate data directory
while testing changes that should not touch normal application state:

```bash
PIZZA_DATA_ROOT=/tmp/pizza-bot-dev npm run dev
```

Use an operating-system-appropriate temporary path on Windows.

## CLI

The CLI is an HTTP client, so start a backend before opening the shell:

```bash
# terminal A
PORT=8080 npx tsx apps/api-server/src/index.ts

# terminal B
npm run shell
npm run shell -- "one-shot prompt"
```

The server URL defaults to `http://localhost:8080`. Override it with
`PIZZA_REMOTE_URL` or `PIZZA_API_URL`, and set `PIZZA_API_TOKEN` when the server
requires bearer authentication. Interactive commands are `/reset`, `/help`, and
`/exit`.

The packaged `pizza` executable is the same remote client. Build its workspace
before invoking it directly:

```bash
npm run build -w @pizza-bot/cli
./node_modules/.bin/pizza
```

## Browser development

Run the backend and Vite separately:

```bash
# terminal A
PORT=8080 npx tsx apps/api-server/src/index.ts

# terminal B
npm run dev -w @pizza-bot/web
```

Open `http://localhost:5173`. Vite proxies `/api` to port `8080`; set
`PIZZA_API_TARGET` when the backend uses another origin. Set
`PIZZA_ALLOWED_ORIGINS` on the backend when Vite runs on a non-default port.

## Desktop packages

Build an unpacked application with:

```bash
npm run desktop:package
```

Build platform installers with:

```bash
npm run desktop:make
```

See the [desktop-shell guide](../apps/desktop-shell/README.md) for output paths,
supported platforms, signing, notarization, native dependencies, and installer
behavior.

## Standalone and remote backends

The production backend bundle can serve the CLI, browser, or an Electron client
on another machine. See [Running a standalone backend](STANDALONE_BACKEND.md)
for authentication, remote Electron setup, static browser deployment, Docker,
Compose, Kubernetes, systemd, Caddy, backups, and troubleshooting.
