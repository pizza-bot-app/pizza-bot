# Built-in Agent Skills

This directory is the source location for source-controlled **Agent Skills**
shipped with the application. Additional skills in this repository are bundled
by plugins. Each built-in skill uses a `SKILL.md`
([Anthropic's convention](https://www.anthropic.com/news/skills)) plus optional
sibling files.

A skill is a playbook an agent reads when a task calls for it. Skills carry
instructions and sibling files (`reference.md`, scripts, assets) and nothing else:
tools, models, and approvals belong to the [agent](../docs/EXTENDING.md#agents)
that mounts the skill. The runtime serves every enabled skill read-only under
`/skills/<id>/` and loads it with DeepAgents' native skills middleware, so an agent
sees each mounted skill's name and description and reads the full `SKILL.md` only
when it needs to.

A skill that an agent lists in its `skills` belongs to that agent. Every other
enabled skill is mounted on Pizza Bot itself.

**Three catalogs merge into one**, resolved at startup:

1. **Built-in** — this directory, via `loadBuiltinSkills()`.
2. **Plugin** — skills contributed by installed plugins, via
   `loadSkillCatalog()` (the installed source remains read-only).
3. **User** — `<data-root>/skills` (`~/.pizza-bot-oss/skills` by default), via
   `loadUserSkills()`.

User skills win on an id collision, so editing a Built-in or Plugin skill creates
a user override. Text resources are stored as UTF-8 strings; binary assets such as
images, PDFs, and archives keep their bytes and MIME type. The JSON Skill API
represents binary content as base64 with `encoding: "base64"`.

## Adding a built-in skill

1. Create `skills/<id>/SKILL.md` with YAML frontmatter carrying at least a
   `description` (a skill with none is skipped — the model can't decide to use
   it) and ideally a `name`. Write the body as a clear, step-by-step playbook.
2. Add any nested scripts, references, or assets the body references; relative
   paths are preserved and resources load on demand.

## Write the description for the agent that reads it

The `description` is what an agent sees before it decides to open the skill, so
name the situations it covers and the phrases a user would actually say. The
routing guidance for delegation lives on agents; see
[Extending Pizza Bot](../docs/EXTENDING.md#agents).

## Editing

User skills are editable through `POST/PATCH/DELETE /skills` (the **Skills**
library UI, or the API directly) — a write is live on response: the server
rewrites the bundle under `<data-root>/skills`, re-scans that directory, and
rebuilds the agents so the next turn reads the new version. Editing a
Built-in or Plugin skill creates a user override; deleting the override reveals
the original version again. Override the user directory with
`PIZZA_SKILLS_DIR` and this built-in directory with `PIZZA_BUILTIN_SKILLS_DIR`.
