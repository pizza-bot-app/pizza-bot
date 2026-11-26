# Troubleshooting

## A run cannot start

- Confirm that a provider and model are configured under
  **Settings > Providers**.
- Confirm that the provider credentials are available to the backend in use.
- Check the Logs screen for the provider or runtime error.
- If a Google Gemini model fails on Vertex AI with
  `Publisher model ... us-central1 ... was not found`, set **Vertex AI project
  ID** (the project ID, or the number shown in `projects/<number>/` in the
  error) and leave **Vertex AI location** at `global` under **Settings >
  Providers > Google** (Vertex AI Express serves only `us-central1`). Under
  **Auto-detect**, a project ID selects Vertex AI, so clear it if the key is a
  Google AI Studio key.
- After fixing the cause of a failed run, choose **Retry** on the error, or send
  the same message again; either re-runs the turn without repeating the message.

## A skill is unavailable

- Open the skill and review its required tools.
- Confirm that each required MCP server is enabled and connected.
- Reconnect a failed MCP server from its detail screen.
- Confirm that the skill itself is enabled.

## Browser Automation cannot open a browser

- Install Chrome, Edge, or Chromium, or run `npm run browser:install` when
  working from source.
- Confirm that the Playwright MCP server is enabled and connected.
- On a headless backend, configure a browser that can run without a desktop
  session.

## Browser requests receive 403 errors

Set `PIZZA_ALLOWED_ORIGINS` to the exact web origin. This commonly occurs when
Vite starts on a non-default port.

## Source commands fail unexpectedly

- Use Node.js 24 or newer.
- Run `npm install` in the current worktree.
- Run `npm run build` before starting an application entrypoint.

## Where to look next

- Running: https://github.com/pizza-bot-app/pizza-bot/blob/main/docs/RUNNING.md
- Logging: https://github.com/pizza-bot-app/pizza-bot/blob/main/docs/LOGGING.md
- Issues: https://github.com/pizza-bot-app/pizza-bot/issues
