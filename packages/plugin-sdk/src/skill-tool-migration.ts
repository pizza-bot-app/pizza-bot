/**
 * Moves tool grants and approval policy out of user SKILL.md files into an agent
 * that mounts the skill, so the skill stays spec-compliant and keeps its tools.
 * TODO: remove one release after agent definitions ship.
 */
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { parseDeclaredTools, parseInterruptOn, PIZZA_BOT_AGENT } from "@pizza-bot/core";
import { AGENT_FILE_EXT, composeAgentMd } from "./agent-catalog.js";

const FRONTMATTER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;
const AGENT_KEYS = ["tools", "mcp", "interruptOn"] as const;

export async function migrateSkillToolGrants(
  skillsDir: string,
  agentsDir: string,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const migrated: string[] = [];
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const linked = entry.isSymbolicLink();
    if ((!entry.isDirectory() && !linked) || entry.name === PIZZA_BOT_AGENT.id) continue;
    const id = entry.name;
    const skillMd = join(skillsDir, id, "SKILL.md");
    try {
      const raw = await readFile(skillMd, "utf8").catch(() => undefined);
      const match = raw === undefined ? null : FRONTMATTER.exec(raw);
      if (!raw || !match) continue;
      const doc = parseDocument(match[2]!);
      if (doc.errors.length > 0 || !AGENT_KEYS.some((key) => doc.has(key))) continue;
      // A linked skill is edited at its source, so never rewrite it through the link.
      if (linked) {
        log(`skill "${id}": linked skill still declares tools or interruptOn; move them into an agent that mounts it`);
        continue;
      }
      const data = doc.toJS() as Record<string, unknown>;
      const description = typeof data.description === "string" ? data.description.trim() : "";
      if (!description) continue;
      const agentPath = join(agentsDir, `${id}${AGENT_FILE_EXT}`);
      if (await access(agentPath).then(() => true, () => false)) {
        log(`skill "${id}": tool grants ignored; agent "${id}" already exists, so they were not moved`);
        continue;
      }
      await mkdir(agentsDir, { recursive: true });
      await writeFile(agentPath, composeAgentMd({
        id,
        description,
        systemPrompt: `Handle every request by following the \`${id}\` skill.`,
        declaredTools: parseDeclaredTools({ tools: data.tools ?? data.mcp }),
        skills: [id],
        interruptOn: parseInterruptOn(data),
      }), { flag: "wx" });
      for (const key of AGENT_KEYS) doc.delete(key);
      await writeFile(
        skillMd,
        `${match[1]}${doc.toString().trimEnd()}${match[3]}${raw.slice(match[0].length)}`,
      );
      migrated.push(id);
      log(`skill "${id}": moved tool grants into agent "${id}"`);
    } catch (err) {
      log(`skill "${id}": tool grant migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return migrated;
}
