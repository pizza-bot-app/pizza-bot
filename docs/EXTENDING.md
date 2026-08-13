# Extending Pizza Bot

Pizza Bot combines MCP servers, Agent Skills, and plugins:

- **MCP servers** expose tools.
- **Skills** turn instructions and a scoped tool set into delegatable workers.
- **Plugins** package MCP servers and skills for installation and distribution.

All three can be managed from the application UI.

## MCP servers

Create a server from the **MCP Servers** screen or add a Claude Code-compatible
entry to `<PIZZA_DATA_ROOT>/.mcp.json`. The default data root is
`~/.pizza-bot-oss`.

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {
        "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}"
      }
    }
  }
}
```

Keep secrets out of `.mcp.json`. Put them in `<PIZZA_DATA_ROOT>/.env` or
`.env.local` and reference them as `${ENV_VAR}`. The api-server loads these
files without overriding variables exported by its parent process. Restart
Pizza Bot or the standalone api-server after changing an environment file.

String fields expand environment references when the server connects. Set
`"enabled": false` to retain a server without launching it. Failed servers can
be retried from their detail screen without reconnecting healthy servers.

Startup connects to at most three servers concurrently and gives each attempt
20 seconds by default. Override these limits with
`PIZZA_MCP_STARTUP_CONCURRENCY` and
`PIZZA_MCP_CONNECTION_TIMEOUT_MS`.

## Skills

Pizza Bot is the conversation agent; each enabled, ready skill becomes a
tool-scoped worker that Pizza Bot can invoke through the `task` tool. The skill's
name and description guide routing, its `SKILL.md` body supplies the worker
instructions, and its declared tools define the complete tool surface.

User skills live under `<PIZZA_DATA_ROOT>/skills/<id>/SKILL.md`. They override
built-in or plugin skills with the same id. A minimal MCP-backed skill looks like:

```markdown
---
name: release-check
description: Check release readiness and report blockers.
tools:
  - mcp:release-tools:check_release
---

1. Run the release check.
2. Group blockers by owner.
3. Return a concise readiness report.
```

A skill becomes callable only after all of its declared MCP servers and tools
are enabled and connected. Loading or unavailable skills remain visible but are
omitted from the worker list until their dependencies recover. Newly ready
skills become available on the next turn.

Use `interruptOn` in the frontmatter to require human approval for a tool. The
allowed decisions drive the application's approval card:

```yaml
interruptOn:
  "mcp:release-tools:publish_release":
    allowedDecisions:
      - approve
      - edit
      - reject
```

See the [skills guide](../skills/README.md) for catalog precedence, built-in
skills, sibling resources, and editing behavior.

## Plugins

The **Plugins** screen installs ZIP bundles containing
`.claude-plugin/plugin.json`. Plugins may contribute MCP servers and skills;
their MCP commands and optional materializers execute with the current user's
permissions. Install only sources you trust.

See the [plugins guide](../plugins/README.md) for the supported manifest subset,
resource paths, materializers, and packaging shipped plugin dependencies.

