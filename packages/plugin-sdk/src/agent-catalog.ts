/** Loads `agents/<id>.md` definitions (Claude Code subagent layout) into the runtime catalog. */
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { stringify } from "yaml";
import {
  PIZZA_BOT_AGENT,
  parseAgentModel,
  parseAgentSkills,
  parseDeclaredTools,
  parseInterruptOn,
  type AgentCatalog,
  type AgentCatalogEntry,
  type AgentSource,
  type InterruptOnPolicy,
} from "@pizza-bot/core";
import type { ContributionRegistry } from "./registry.js";
import { splitFrontmatter } from "./frontmatter.js";

export const AGENT_FILE_EXT = ".md";

type Provenance =
  | { source: "plugin"; pluginName: string }
  | { source: Exclude<AgentSource, "plugin"> };

/** Parses one agent file; returns null when it has no description to route by. */
export function parseAgentMd(
  id: string,
  raw: string,
  provenance: Provenance,
): AgentCatalogEntry | null {
  if (id === PIZZA_BOT_AGENT.id) {
    throw new Error(`"${id}" is reserved for the top-level agent and cannot be an agent id`);
  }
  const { data, body, error } = splitFrontmatter(raw);
  // Recovery keeps only name/description, which would silently drop tool and approval policy.
  if (error) throw new Error(`invalid frontmatter: ${error}`);
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) return null;
  const model = parseAgentModel(data);
  const base = {
    id,
    name: displayName(data, id),
    description,
    systemPrompt: body.trim(),
    ...(model ? { model } : {}),
    declaredTools: parseDeclaredTools(data),
    skills: parseAgentSkills(data),
    interruptOn: parseInterruptOn(data),
  };
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
  return fallback;
}

export interface AgentMdFields {
  id: string;
  name?: string;
  description: string;
  systemPrompt: string;
  model?: string;
  declaredTools?: readonly string[];
  skills?: readonly string[];
  interruptOn?: InterruptOnPolicy;
}

/** Inverse of {@link parseAgentMd}; `name` is the id so the file stays a valid Claude Code subagent. */
export function composeAgentMd(fields: AgentMdFields): string {
  const frontmatter: Record<string, unknown> = {
    name: fields.id,
    description: fields.description,
  };
  if (fields.name && fields.name !== fields.id) {
    frontmatter.metadata = { "display-name": fields.name };
  }
  if (fields.model) frontmatter.model = fields.model;
  if (fields.declaredTools?.length) frontmatter.tools = [...fields.declaredTools];
  if (fields.skills?.length) frontmatter.skills = [...fields.skills];
  if (fields.interruptOn && Object.keys(fields.interruptOn).length > 0) {
    frontmatter.interruptOn = fields.interruptOn;
  }
  const body = fields.systemPrompt.trim();
  const head = `---\n${stringify(frontmatter).trimEnd()}\n---\n`;
  return body ? `${head}\n${body}\n` : head;
}

/** Invalid plugin agents are logged and skipped without blocking their siblings. */
export async function loadAgentCatalog(
  registry: ContributionRegistry,
  log: (msg: string) => void = () => {},
): Promise<AgentCatalog> {
  const catalog: AgentCatalog = new Map();
  for (const [id, contribution] of registry.agents) {
    try {
      const raw = await readFile(contribution.value, "utf8");
      const entry = parseAgentMd(id, raw, { source: "plugin", pluginName: contribution.pluginName });
      if (entry) {
        catalog.set(id, entry);
        log(`agent "${id}" from plugin "${contribution.pluginName}"`);
      } else {
        log(`skipping agent "${id}": no description at ${contribution.value}`);
      }
    } catch (err) {
      log(`skipping agent "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return catalog;
}

export function loadUserAgents(dir: string, log: (msg: string) => void = () => {}): Promise<AgentCatalog> {
  return loadAgentsDirectory(dir, "user", log);
}

export function loadBuiltinAgents(dir: string, log: (msg: string) => void = () => {}): Promise<AgentCatalog> {
  return loadAgentsDirectory(dir, "builtin", log);
}

async function loadAgentsDirectory(
  dir: string,
  source: Exclude<AgentSource, "plugin">,
  log: (msg: string) => void,
): Promise<AgentCatalog> {
  const catalog: AgentCatalog = new Map();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== AGENT_FILE_EXT) continue;
    const id = entry.name.slice(0, -AGENT_FILE_EXT.length);
    const path = join(dir, entry.name);
    try {
      const agent = parseAgentMd(id, await readFile(path, "utf8"), { source });
      if (agent) {
        catalog.set(id, agent);
        log(`${source} agent "${id}"`);
      } else {
        log(`skipping ${source} agent "${id}": no description at ${path}`);
      }
    } catch (err) {
      log(`skipping ${source} agent "${id}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return catalog;
}

/** User agents replace shipped agents with the same id; inputs are not mutated. */
export function mergeAgentCatalogs(
  shipped: AgentCatalog,
  user: AgentCatalog,
  log: (msg: string) => void = () => {},
): AgentCatalog {
  const merged: AgentCatalog = new Map(shipped);
  for (const [id, entry] of user) {
    const replaced = merged.get(id);
    if (replaced) log(`user agent "${id}" overrides shipped agent of the same id (user wins)`);
    merged.set(
      id,
      replaced && replaced.source !== "user" ? { ...entry, overrides: replaced.source } : entry,
    );
  }
  return merged;
}
