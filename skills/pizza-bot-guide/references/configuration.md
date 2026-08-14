# Configuration

## Ways to run Pizza Bot

- **Electron desktop** runs the inbox with an embedded local backend.
- **Browser** connects the web interface to an api-server.
- **Terminal CLI** connects to an api-server from a shell or script.
- **Standalone backend** supports remote Electron clients, static web
  deployments, Docker, and Linux services.

Running from source requires Node.js 24 or newer:

```bash
npm install
npm run build
npm run dev
```

## Model providers

Pizza Bot supports Amazon Bedrock, Anthropic, Google Gemini, OpenAI, OpenRouter,
and Ollama. Configure providers under **Settings > Providers**, then select a
model suited to the task.

Provider configuration can also use environment-variable references. The
standalone backend must have access to the referenced variables.

## Local and remote backends

The desktop app uses its embedded backend by default. It can instead connect to
a remote backend over HTTPS with a shared bearer token. Provider credentials for
a remote backend must be configured on the backend host; desktop provider
settings apply only to the embedded backend.

## Data root

`PIZZA_DATA_ROOT` selects where Pizza Bot stores conversations, checkpoints,
memory, attachments, plugins, custom skills, configuration, and logs. The
default is `~/.pizza-bot-oss`.

More detail:

- Running: https://github.com/pizza-bot-app/pizza-bot/blob/main/docs/RUNNING.md
- Standalone backend:
  https://github.com/pizza-bot-app/pizza-bot/blob/main/docs/STANDALONE_BACKEND.md
