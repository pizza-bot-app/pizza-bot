# Built-in Agent Skills

This directory is the source location for source-controlled **Agent Skills**
shipped with the application. Additional skills in this repository are bundled
by plugins. Each built-in skill uses a `SKILL.md`
([Anthropic's convention](https://www.anthropic.com/news/skills)) plus optional
sibling files.

Pizza Bot is the only conversation agent; **skills are how you extend it.** A
skill has a `name` and `description`, which Pizza Bot uses to decide when to
delegate through the `task` tool. Each enabled, ready skill compiles into a
tool-scoped worker: its `SKILL.md` body is the worker's system prompt and its
declared `mcp:server:tool` references are its complete tool surface. Sibling
files (`reference.md`, scripts, assets, and so on) are seeded with the skill and
remain available to the worker when its instructions call for them.

**Three catalogs merge into one**, resolved at startup:

1. **Built-in** — this directory, via `loadBuiltinSkills()`.
2. **Plugin** — skills contributed by installed plugins, via
   `loadSkillCatalog()` (the installed source remains read-only).
3. **User** — `<data-root>/skills` (`~/.pizza-bot-oss/skills` by default), via
   `loadUserSkills()`.

User skills win on an id collision, so editing a Built-in or Plugin skill creates
a user override. The runtime projects enabled, ready entries from the merged
catalog into workers and seeds each bundle into run state so DeepAgents'
StateBackend can serve it — see
[`packages/core/src/skill.ts`](../packages/core/src/skill.ts). Text
resources are stored as UTF-8 strings; binary assets such as images, PDFs, and
archives are stored as DeepAgents FileDataV2 bytes with a MIME type. The JSON
Skill API represents binary content as base64 with `encoding: "base64"`.

## Adding a built-in skill

1. Create `skills/<id>/SKILL.md` with YAML frontmatter carrying at least a
   `description` (a skill with none is skipped — the model can't decide to use
   it) and ideally a `name`. Write the body as a clear, step-by-step playbook.
2. Add any nested scripts, references, or assets the body references; relative
   paths are preserved and resources load on demand.

## Write the description for two readers

The `description` is the **only** part of a skill Pizza Bot ever sees — it does
not read `SKILL.md` before delegating. So it does two jobs, and most descriptions
only do the first:

1. **Selection** — when should this worker be picked? Name the domain and the
   phrases a user would actually say ("my notes", "my vault").
2. **Expectation** — what does the worker decide for itself, and what does it
   return? Without this, Pizza Bot has to guess, and it guesses by writing a spec
   into the dispatch: an output format, a field list, a time range the user never
   asked for. Stating that the worker already picks its own time window, or that
   a task review comes back with source notes and due dates, removes the gap it
   would otherwise fill.

A live ablation on two skills measured 36% shorter dispatches from adding one
"decides X itself, returns Y" sentence, and it stopped one request from being
split across redundant workers. Describe only what the worker really does —
a description that overpromises makes Pizza Bot dispatch work the skill cannot
deliver.

The built-in catalog is discovered automatically; there is no orchestrator list
to edit. A skill with MCP dependencies becomes callable after every declared
server and tool is enabled and connected.

## Editing

User skills are editable through `POST/PATCH/DELETE /skills` (the **Skills**
library UI, or the API directly) — a write is live on response: the server
rewrites the bundle under `<data-root>/skills`, re-scans that directory, and
rebuilds the agents so the change is seeded into the next run. Editing a
Built-in or Plugin skill creates a user override; deleting the override reveals
the original version again. Override the user directory with
`PIZZA_SKILLS_DIR` and this built-in directory with `PIZZA_BUILTIN_SKILLS_DIR`.
