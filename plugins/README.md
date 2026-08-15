# Plugins

Pizza Bot scans three plugin locations:

1. This directory for plugins shipped with the OSS application.
2. `<data-root>/plugins` for installation-specific plugins.
3. `~/.pizza-bot/plugins` for independently distributed plugins.

`PIZZA_EXTERNAL_PLUGINS_DIRS` overrides the third location with a
platform-delimited list.

The **Plugins** page installs a plugin from a ZIP containing a directory with
`.claude-plugin/plugin.json` into `<data-root>/plugins` and reloads it live —
no server restart. Only plugins installed there are removable through the UI;
plugins shipped with the app or dropped into an external directory are
read-only. The install and removal reconnect MCP servers and re-scan skills in
place.

Plugins use a supported subset of the Claude Code plugin format. Most are
declarative bundles that contribute two resource kinds:

- **MCP servers** — a `.mcp.json` in Claude Code's `{ mcpServers }` shape. Tools
  convert to LangChain tools the runtime consumes directly. String fields expand
  `${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_ROOT}` (the plugin's on-disk dir) and
  `${ENV_VAR}` (from the environment) at load time, so secrets stay out of the
  committed manifest. Set `enabled: false` on an entry to ship it disabled.
- **Agent Skills** — one `SKILL.md` per capability under `skills/<id>/`. The
  runtime compiles each into a tool-scoped worker only after all of its declared
  tools are ready. See [../skills/README.md](../skills/README.md).

A manifest lives at `<plugin>/.claude-plugin/plugin.json`. Unsupported fields
(such as `commands` or a `pizzaBot.ui` block) are parsed and dropped rather than
rejected, so a Claude Code plugin that carries them still loads — but the host
executes no plugin-supplied web components.

The complete [MCP status example](../examples/plugins/mcp-status) is a small,
self-contained reference plugin with a manifest, MCP server, and matching
skill. It has no install step or external dependencies, so it can be copied or
zipped as-is when starting a plugin.

## Bundled Plugins

`playwright-mcp` provides browser automation through a locked
`@playwright/mcp` dependency and a matching `browser-automation` Agent Skill.
The skill uses accessibility snapshots for interaction and omits Playwright
MCP's RCE-equivalent unsafe-code tool.

The launcher uses an installed Chrome, Edge, or Chromium when it finds one.
When running from source, it falls back to the exact Chrome for Testing revision
downloaded for the locked Playwright dependency:

```bash
npm run browser:install
```

`npm run dev` runs that command automatically before starting the application.
It returns immediately when the exact executable is already cached. On a cold
cache it invokes Playwright's installer, downloads the browser, and requires
network access.

Pizza Bot installers do not include Chrome for Testing or another browser. A
packaged app uses Chrome, Edge, or Chromium already installed on the machine
(or the matching Chrome for Testing revision if it already exists in
Playwright's cache). If none is available, install one of those supported
browsers and reconnect the Playwright MCP server. Set
`PIZZA_PLAYWRIGHT_BROWSER_PATH` when the browser is outside the backend
process's `PATH`; the launcher also checks conventional Linux Chrome, Edge,
Chromium, and Snap locations. It selects headless mode when Linux has no display
server.

The default Linux backend image does not include a browser. Build its
`runtime-with-browser` target when browser automation must be self-contained.
Browsers installed on the container host are not visible inside the container.
When no supported browser is visible, the server reports an actionable
`browser_not_found` status and the rest of the backend remains available.

Playwright's npm packages do not download browsers from an install or
postinstall script. The root `allowScripts` policy and the packager's
`--ignore-scripts` option therefore do not control browser installation;
`npm run browser:install` is the explicit, repository-owned download.

## Materialized plugins

A plugin can generate its declarative contributions from another local source
by declaring the `dev.pizzabot.materializer` extension:

```json
{
  "name": "generated-tools",
  "extensions": {
    "dev.pizzabot.materializer": {
      "entrypoint": "./dist/materialize.mjs",
      "sourceRoots": ["~/.local/share/generated-tools"],
      "sync": ["install", "startup", "manual"],
      "timeoutMs": 30000
    }
  }
}
```

The host executes the entrypoint with its Node runtime, followed by the expanded
source roots as positional arguments. It sets
`PIZZA_MATERIALIZER_OUTPUT_DIR`, `PIZZA_MATERIALIZER_PLUGIN_NAME`, and
`PIZZA_MATERIALIZER_PLUGIN_ROOT`. The process must write a complete plugin tree,
including `.claude-plugin/plugin.json`, under the output directory. Generated
paths are validated with the normal plugin loader before activation, and the
generated manifest name must match the source plugin.

Validated output is activated as a versioned snapshot under
`<data-root>/plugin-materializations`. A failed refresh keeps the last successful
snapshot active and reports the plugin as stale. The Plugins page can trigger a
manual refresh. There is no filesystem watcher; use startup or manual sync when
the source changes.

Materializer entrypoints are trusted local code with the user's permissions.
ZIP import asks for confirmation before installation.

## Shipped plugin dependencies

Desktop and backend artifacts install shipped plugin dependencies from
`plugins/package-lock.json`. When adding or removing a shipped plugin, update the
workspace list in `plugins/package.json`. After changing that list or a shipped
plugin's dependencies, regenerate the staging lockfile:

```bash
cd plugins
npm install --package-lock-only --ignore-scripts
```

The packaging step validates that the workspace list matches the shipped plugin
directories and runs `npm ci --omit=dev --ignore-scripts` against this lockfile.
