# Security and Data

## Local-first defaults

The embedded api-server binds to `127.0.0.1`. Non-loopback access requires an
API token and an explicit browser-origin allowlist.

Application state is stored under `PIZZA_DATA_ROOT` by default. Model requests
and MCP tool calls go to the providers and endpoints the user configures.
Local-first does not mean every workflow stays offline.

## Credentials

The desktop app protects entered secrets with Electron `safeStorage`. On Linux,
`safeStorage` can fall back to `basic_text` when a compatible secret store is
unavailable; that fallback is not meaningful encryption.

Standalone configuration should store environment-variable references rather
than literal secrets. Do not commit provider keys, MCP credentials, or bearer
tokens.

## Plugins and MCP servers

Plugins, MCP commands, and plugin materializers run with the current user's
permissions. They can access anything that user can access unless the external
tool provides a stronger sandbox. Review the source and requested capabilities
before installation.

## Remote access

Remote backends use one shared bearer token with full API access. Use HTTPS,
restrict allowed origins, protect the token, and do not place it in a URL.

Complete security model:

https://github.com/pizza-bot-app/pizza-bot/blob/main/SECURITY.md
