# MCP status example plugin

This minimal plugin packages one stdio MCP server and one Agent Skill:

```text
.claude-plugin/plugin.json
.mcp.json
skills/health-report/SKILL.md
src/server.js
```

The server uses only Node.js built-ins, so the directory can be loaded or
zipped as-is. Install the ZIP from Pizza Bot's **Plugins** page, or copy the
directory under `<PIZZA_DATA_ROOT>/plugins` while developing.

The `${CLAUDE_PLUGIN_ROOT}` placeholder in `.mcp.json` resolves to the installed
plugin directory. The skill declares the server's tool by its fully qualified
`mcp:<server>:<tool>` name.
