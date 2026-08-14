# Extensions

## Skills

Skills give Pizza Bot specialized instructions and a limited tool surface. The
Skills library shows where each skill came from:

- **Built-in** skills are part of Pizza Bot and work without an installed
  plugin.
- **Plugin** skills are contributed by a plugin.
- **Custom** skills are created by the user.
- **Customized** skills are user overrides of a Built-in or Plugin skill.

Editing a Built-in or Plugin skill creates a custom override without changing
the original. Deleting the override reveals the original version again.

## MCP servers

MCP servers provide external tools. Add them from the MCP Servers screen or from
`<PIZZA_DATA_ROOT>/.mcp.json`. Keep secrets in environment variables and
reference them from configuration rather than writing literal credentials into
the file.

## Plugins

Plugins package MCP servers and skills together. Install ZIP bundles from the
Plugins screen. Plugin commands run with the user's operating-system
permissions, so install only sources you trust.

Pizza Bot bundles the Playwright Browser Automation plugin. It provides browser
inspection and interaction through Playwright MCP and is labeled **Plugin** in
the library.

Marketplace integration is being explored to make skills and plugins easier to
find, install, and update. It is not part of the current installation flow.

More detail:

- Extending Pizza Bot:
  https://github.com/pizza-bot-app/pizza-bot/blob/main/docs/EXTENDING.md
- Plugin format:
  https://github.com/pizza-bot-app/pizza-bot/blob/main/plugins/README.md
- Built-in skills:
  https://github.com/pizza-bot-app/pizza-bot/blob/main/skills/README.md
