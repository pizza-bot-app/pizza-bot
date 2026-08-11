/** Loads plugin and user Agent Skills into the runtime catalog shape. */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  PIZZA_BOT_AGENT,
  SKILLS_ROOT,
  isBinarySkillMimeType,
  parseDeclaredTools,
  parseSkillInterruptOn,
  skillMimeType,
  type SkillCatalog,
  type SkillCatalogEntry,
  type SkillFile,
} from "@pizza-bot/core";
import type { ContributionRegistry } from "./registry.js";
import { parseFrontmatter } from "./frontmatter.js";

const SKILL_MD = "SKILL.md";

/**
 * Invalid plugin skills are logged and skipped without preventing valid siblings
 * from loading.
 */
export async function loadSkillCatalog(
  registry: ContributionRegistry,
  log: (msg: string) => void = () => {},
): Promise<SkillCatalog> {
  const catalog: SkillCatalog = new Map();
  for (const [id, contribution] of registry.skills) {
    try {
      const provenance = {
        source: "plugin" as const,
        pluginName: contribution.pluginName,
      };
      const entry = await readSkillBundle(id, contribution.value, provenance);
      if (entry) {
        catalog.set(id, entry);
        log(`skill "${id}" (${entry.files.length} file(s)) from plugin "${contribution.pluginName}"`);
      } else {
        log(`skipping skill "${id}": no SKILL.md with a description at ${contribution.value}`);
      }
    } catch (err) {
      log(`skipping skill "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return catalog;
}

const SKILL_DIR_FILE = SKILL_MD;

/**
 * Scans `<skillsDir>/<id>/SKILL.md`. Missing directories and unusable skills are
 * skipped so one local entry cannot prevent startup.
 */
export async function loadUserSkills(
  skillsDir: string,
  log: (msg: string) => void = () => {},
): Promise<SkillCatalog> {
  return loadSkillsDirectory(skillsDir, "user", log);
}

/** Loads application-shipped skills separately from mutable user overrides. */
export async function loadBuiltinSkills(
  skillsDir: string,
  log: (msg: string) => void = () => {},
): Promise<SkillCatalog> {
  return loadSkillsDirectory(skillsDir, "builtin", log);
}

async function loadSkillsDirectory(
  skillsDir: string,
  source: "builtin" | "user",
  log: (msg: string) => void,
): Promise<SkillCatalog> {
  const catalog: SkillCatalog = new Map();
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const dir = join(skillsDir, id);
    try {
      const skill = await readSkillBundle(id, dir, { source });
      if (skill) {
        catalog.set(id, skill);
        log(`${source} skill "${id}" (${skill.files.length} file(s))`);
      } else {
        log(`skipping ${source} skill "${id}": no ${SKILL_DIR_FILE} with a description at ${dir}`);
      }
    } catch (err) {
      log(`skipping ${source} skill "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return catalog;
}

/**
 * User skills replace shipped skills with the same identifier. Inputs are not
 * mutated and collisions are logged.
 */
export function mergeSkillCatalogs(
  shipped: SkillCatalog,
  user: SkillCatalog,
  log: (msg: string) => void = () => {},
): SkillCatalog {
  const merged: SkillCatalog = new Map(shipped);
  for (const [id, entry] of user) {
    const replaced = merged.get(id);
    if (replaced) {
      log(`user skill "${id}" overrides shipped skill of the same id (user wins)`);
    }
    merged.set(
      id,
      replaced && replaced.source !== "user"
        ? { ...entry, overrides: replaced.source }
        : entry,
    );
  }
  return merged;
}

/**
 * Maps a root-contained recursive bundle to `/skills/<id>/`, with `SKILL.md`
 * first and remaining files sorted for deterministic state seeding.
 */
async function readSkillBundle(
  id: string,
  path: string,
  provenance:
    | { source: "plugin"; pluginName: string }
    | { source: "builtin" | "user" },
): Promise<SkillCatalogEntry | null> {
  if (id === PIZZA_BOT_AGENT.id) {
    throw new Error(
      `"${id}" is reserved for the top-level agent and cannot be a skill id`,
    );
  }
  const st = await stat(path).catch(() => null);
  if (!st) return null;

  const members: Array<{ rel: string; abs: string }> = [];
  if (st.isDirectory()) {
    members.push(...await collectBundleFiles(path));
  } else {
    members.push({ rel: SKILL_MD, abs: path });
  }

  const skillMd = members.find((m) => m.rel === SKILL_MD);
  if (!skillMd) return null;

  const skillMdRaw = await readFile(skillMd.abs, "utf8");
  const fm = parseFrontmatter(skillMdRaw);
  const description = typeof fm.description === "string" ? fm.description : "";
  if (!description) return null;
  const name = displayName(fm, id);
  const declaredTools = parseDeclaredTools(fm);
  const interruptOn = parseSkillInterruptOn(fm);

  const ordered = [skillMd, ...members.filter((m) => m.rel !== SKILL_MD).sort((a, b) => a.rel.localeCompare(b.rel))];
  const files: SkillFile[] = [];
  for (const m of ordered) {
    const virtualPath = `${SKILLS_ROOT}/${id}/${m.rel}`;
    if (m.abs === skillMd.abs) {
      files.push({ path: virtualPath, content: skillMdRaw, mimeType: "text/markdown" });
      continue;
    }
    const bytes = await readFile(m.abs);
    const declaredMimeType = skillMimeType(m.rel);
    if (isBinarySkillMimeType(declaredMimeType)) {
      files.push({
        path: virtualPath,
        content: new Uint8Array(bytes),
        mimeType: declaredMimeType,
      });
      continue;
    }
    try {
      files.push({
        path: virtualPath,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        mimeType: declaredMimeType,
      });
    } catch {
      // Invalid UTF-8 proves the file is binary even when its extension is
      // unknown (or conventionally text), so preserve it as opaque bytes.
      if (declaredMimeType === "text/plain") {
        files.push({
          path: virtualPath,
          content: new Uint8Array(bytes),
          mimeType: "application/octet-stream",
        });
      } else {
        throw new Error(`skill bundle file "${m.rel}" is not valid UTF-8 text`);
      }
    }
  }

  const base = { id, name, description, files, declaredTools, interruptOn };
  return provenance.source === "plugin"
    ? { ...base, source: "plugin", pluginName: provenance.pluginName }
    : { ...base, source: provenance.source };
}

function displayName(frontmatter: Record<string, unknown>, fallback: string): string {
  const metadata = frontmatter.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)["display-name"];
    if (typeof value === "string" && value) return value;
  }
  return typeof frontmatter.name === "string" && frontmatter.name
    ? frontmatter.name
    : fallback;
}

async function collectBundleFiles(rootPath: string): Promise<Array<{ rel: string; abs: string }>> {
  const root = resolve(rootPath);
  const files: Array<{ rel: string; abs: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) continue;
      // Skill bundles are data. Never follow symlinks outside (or around) root.
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          rel: relative(root, absolute).split(sep).join("/"),
          abs: absolute,
        });
      }
    }
  };
  await visit(root);
  return files;
}
