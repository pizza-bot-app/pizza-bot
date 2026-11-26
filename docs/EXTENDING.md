# Extending Pizza Bot

Pizza Bot combines MCP servers, agents, Agent Skills, and plugins:

- **MCP servers** expose tools.
- **Agents** are specialist subagents Pizza Bot delegates to, each with its own
  instructions, model, tools, skills, and approvals.
- **Skills** are playbooks an agent reads on demand.
- **Plugins** package MCP servers, agents, and skills for installation and
  distribution.

All of them can be managed from the application UI.

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
files without overriding values it already found. Precedence is: exported
process environment, then the data root, current working directory, and
repository root; within each directory `.env.local` overrides `.env`.
Restart Pizza Bot or the standalone api-server after changing an environment
file.

String fields expand environment references when the server connects. Set
`"enabled": false` to retain a server without launching it. Failed servers can
be retried from their detail screen without reconnecting healthy servers.

Startup connects to at most three servers concurrently and gives each attempt
20 seconds by default. Override these limits with
`PIZZA_MCP_STARTUP_CONCURRENCY` and
`PIZZA_MCP_CONNECTION_TIMEOUT_MS`.

## Agents

Pizza Bot is the conversation agent. Each enabled, ready agent becomes a
DeepAgents subagent that Pizza Bot can invoke through the `task` tool, in its own
context, with exactly the tools it declares. An agent is one Markdown file in the
Claude Code subagent layout: frontmatter, then the system prompt.

User agents live at `<PIZZA_DATA_ROOT>/agents/<id>.md`, and a plugin ships them
from the directory its manifest names in `agents`. A user agent overrides a plugin
agent with the same id.

```markdown
---
name: release-check
description: Checks release readiness and reports blockers grouped by owner. Decides on its own which checks to run; returns a readiness verdict and the blocker list.
model: anthropic:claude-haiku-4-5
tools:
  - mcp:release-tools:check_release
  - mcp:release-tools:publish_release
skills:
  - release-policy
interruptOn:
  "mcp:release-tools:publish_release":
    allowedDecisions:
      - approve
      - edit
      - reject
---

Run the release check, group blockers by owner, and return a concise readiness
report. Publish only when the user asks.
```

- `model` is a provider-qualified id from the model picker. Omit it, or use
  `inherit`, to run on the conversation's model. A model that cannot be resolved
  makes the agent unavailable rather than silently switching models.
- `tools` lists `mcp:<server>:<tool>` refs (`mcp:<server>:*` and prefix patterns
  match many), `builtin:eval` for the sandboxed interpreter, and
  `builtin:execute` for shell commands in the conversation's VM. It is the
  agent's complete tool surface beyond the filesystem. An agent granting
  `builtin:execute` stays unavailable unless a shell sandbox is configured
  ([STANDALONE_BACKEND.md](STANDALONE_BACKEND.md#shell-sandbox)).
- `skills` mounts skills on the agent's own skills middleware.
- `interruptOn` pauses a granted MCP tool for a human decision.
- `metadata.display-name` sets the name shown in the UI.

An agent becomes callable only after every declared MCP server and tool is
enabled and connected, every mounted skill is enabled, and its model resolves.
Loading or unavailable agents stay visible but are left out of the `task` roster
until they recover.

### Write the description for two readers

The `description` is the only part of an agent Pizza Bot sees before delegating,
so it does two jobs:

1. **Selection**: when should this agent be picked? Name the domain and the
   phrases a user would actually say ("my notes", "my vault").
2. **Expectation**: what does the agent decide for itself, and what does it
   return? Without this, Pizza Bot guesses by writing a spec into the dispatch:
   an output format or a time range the user never asked for.

A live ablation measured 36% shorter dispatches from adding one "decides X
itself, returns Y" sentence, and it stopped one request from being split across
redundant subagents. Describe only what the agent really does.

## Skills

Skills follow the [Agent Skills](https://agentskills.io) format: a
`SKILL.md` with `name` and `description` frontmatter plus optional sibling files.
User skills live under `<PIZZA_DATA_ROOT>/skills/<id>/SKILL.md`. They can
override a Built-in or Plugin skill with the same id without modifying the
original; deleting an override reveals the Built-in or Plugin skill again.
A `<id>` entry may be a symlink to a folder, for example to keep skills in a git
repo; linked skills are read-only in the app (edit them at the source), and
Unlink removes only the link. A skill linked in while Pizza Bot is running
appears after a restart (#217).

A skill carries no tools. Mount it on an agent with `skills:` to pair it with
the tools it needs; a skill no agent mounts is available to Pizza Bot itself.
A user skill whose frontmatter still declares `tools` or `interruptOn` is
converted on startup or import into an agent of the same id that mounts it.

See the [skills guide](../skills/README.md) for catalog precedence, Built-in
skills, Plugin skills, sibling resources, and editing behavior.

## Plugins

The **Plugins** screen installs ZIP bundles containing
`.claude-plugin/plugin.json`. Plugins may contribute MCP servers, agents, and skills;
their MCP commands and optional materializers execute with the current user's
permissions. A custom agent or skill can replace a plugin-provided one with the
same id; removing the customization restores the plugin version. Plugin MCP server
definitions remain part of the installed bundle. Install only sources you
trust.

The screen retains every discovered bundle and reports whether it loaded, was
disabled by its manifest, is incompatible with this Pizza Bot release, or
failed validation or activation. Disabled plugins are re-enabled by editing
their manifest and setting top-level `enabled` to `true`, then reloading plugins
or restarting Pizza Bot. An installed plugin folder may be a symlink to a folder
kept elsewhere; Remove deletes only the link and leaves the folder in place.

See the [plugins guide](../plugins/README.md) for the supported manifest subset,
resource paths, materializers, and packaging shipped plugin dependencies.
