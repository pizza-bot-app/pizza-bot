/** Pure Agent Skill types and StateBackend projection helpers. */
import { z } from "zod";
import type { HitlDecision } from "./protocol-types.js";

export const SKILLS_ROOT = "/skills";

export const SKILL_MD = "SKILL.md";

export const BUILTIN_EVAL_TOOL_REF = "builtin:eval";

export const toolRefSchema = z
  .string()
  .refine(
    (ref) => ref === BUILTIN_EVAL_TOOL_REF || /^mcp:[^:\s]+:[^:\s]+$/.test(ref),
    "Tool ref must be builtin:eval or mcp:<server>:<tool> without whitespace (wildcards allowed)",
  );

export const interruptToolRefSchema = toolRefSchema.refine(
  (ref) => ref.startsWith("mcp:"),
  "HITL approval can only target MCP tools",
);

export const interruptConfigSchema = z.union([
  z.boolean(),
  z.object({
    allowedDecisions: z.array(
      z.enum(["approve", "edit", "reject", "respond"]) satisfies z.ZodType<HitlDecision>,
    ).min(1),
  }),
]);

export type SkillInterruptConfig =
  | boolean
  | { allowedDecisions: HitlDecision[] };

export type SkillInterruptOn = Record<string, SkillInterruptConfig>;

const BINARY_SKILL_MIME_TYPES: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".avi": "video/x-msvideo",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".tar": "application/x-tar",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".wmv": "video/x-ms-wmv",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

/**
 * Returns the entire input as the body when YAML frontmatter is absent.
 * This must stay aligned with the catalog loader's frontmatter parsing.
 */
export function splitSkillMd(raw: string): { frontmatter: string; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1]!, body: raw.slice(match[0].length).replace(/^\r?\n/, "") };
}

const TOOLS_METADATA_KEY = "pizza-bot-tools";
const INTERRUPT_ON_METADATA_KEY = "pizza-bot-interrupt-on";
const DEFAULT_INTERRUPT_DECISIONS: readonly HitlDecision[] = ["approve", "edit", "reject"];
const ALL_INTERRUPT_DECISIONS: readonly HitlDecision[] = ["approve", "edit", "reject", "respond"];

/**
 * Rebuilds spec-compliant frontmatter. The Agent Skills spec allows only string
 * `metadata` values, so tool grants and HITL policy are space-separated strings
 * there; normalizes surrounding body whitespace for idempotent saves.
 */
export function composeSkillMd(
  name: string,
  description: string,
  body: string,
  declaredTools: readonly string[] = [],
  interruptOn: SkillInterruptOn = {},
  displayName?: string,
): string {
  const metadata: Array<[string, string]> = [];
  if (displayName && displayName !== name) metadata.push(["display-name", displayName]);
  if (declaredTools.length > 0) metadata.push([TOOLS_METADATA_KEY, declaredTools.join(" ")]);
  const interruptRefs = Object.entries(interruptOn).flatMap(([ref, config]) => {
    // `true` is every decision to the HITL middleware, not the bare-ref default.
    if (config === false) return [];
    const decisions = config === true ? ALL_INTERRUPT_DECISIONS : config.allowedDecisions;
    return sameDecisions(decisions, DEFAULT_INTERRUPT_DECISIONS)
      ? [ref]
      : [`${ref}=${decisions.join(",")}`];
  });
  if (interruptRefs.length > 0) metadata.push([INTERRUPT_ON_METADATA_KEY, interruptRefs.join(" ")]);
  const metadataBlock = metadata.length > 0
    ? `metadata:\n${metadata.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("")}`
    : "";
  const fm =
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n` +
    `${metadataBlock}---\n`;
  let bodyStart = 0;
  for (;;) {
    if (body.startsWith("\r\n", bodyStart)) bodyStart += 2;
    else if (body.charCodeAt(bodyStart) === 0x0a) bodyStart += 1;
    else break;
  }
  const trimmed = body.slice(bodyStart).trimEnd();
  return trimmed.length > 0 ? `${fm}\n${trimmed}\n` : fm;
}

export interface SkillFile {
  path: string;
  /** V2 content; line arrays remain accepted for catalogs built by older callers. */
  content: string | string[] | Uint8Array;
  mimeType?: string;
}

export interface SkillFileDataV2 {
  content: string | Uint8Array;
  mimeType: string;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: "plugin" | "builtin" | "user";
  /** Shipped source hidden by this user override, if any. */
  overrides?: "plugin" | "builtin";
  pluginName?: string;
  files: SkillFile[];
  /**
   * Tool references the skill needs, in the same `mcp:<server>:<tool>` (or
   * wildcard) vocabulary as an agent's `tools`. Bound to the skill-as-subagent
   * at delegation time so the specialist has exactly its declared surface.
   */
  declaredTools: string[];
  /** Tool calls that must pause for a durable human decision before execution. */
  interruptOn: SkillInterruptOn;
}

export type SkillCatalog = Map<string, SkillCatalogEntry>;

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: SkillCatalogEntry["source"];
  overrides?: NonNullable<SkillCatalogEntry["overrides"]>;
  pluginName?: string;
  declaredTools: string[];
  interruptOn: SkillInterruptOn;
  enabled?: boolean;
  status?: "disabled" | "loading" | "ready" | "unavailable";
  statusDetail?: string;
  mcpDependencies?: SkillMcpDependencyInfo[];
}

export interface SkillMcpDependencyInfo {
  id: string;
  enabled: boolean;
  status: "missing" | "loading" | "retrying" | "connected" | "error" | "crashed" | "disabled";
}

export function skillInfoOf(entry: SkillCatalogEntry): SkillInfo {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    ...(entry.overrides ? { overrides: entry.overrides } : {}),
    ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
    declaredTools: entry.declaredTools,
    interruptOn: entry.interruptOn,
  };
}

export function skillMcpServerIds(skill: Pick<SkillCatalogEntry, "declaredTools">): string[] {
  const servers = new Set<string>();
  for (const ref of skill.declaredTools) {
    const [kind, server, tool] = ref.split(":");
    if (kind === "mcp" && server && tool) servers.add(server);
  }
  return [...servers];
}

function sameDecisions(a: readonly HitlDecision[], b: readonly HitlDecision[]): boolean {
  return a.length === b.length && a.every((decision, i) => decision === b[i]);
}

function metadataField(frontmatter: Record<string, unknown>, key: string): unknown {
  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function listItems(raw: unknown, separator: RegExp): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(separator) : [];
  return items.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

/**
 * Claude Code permission rules such as `Bash(git add:*)` contain spaces, so a
 * string `allowed-tools` is tokenized with parentheses kept whole. A single
 * linear scan, not a regex: this parses untrusted frontmatter.
 */
function allowedToolItems(raw: unknown): string[] {
  if (typeof raw !== "string") return listItems(raw, /[,\s]+/);
  const items: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of raw) {
    if (depth === 0 && (ch === "," || ch.trim() === "")) {
      if (current) items.push(current);
      current = "";
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    current += ch;
  }
  if (current) items.push(current);
  return items;
}

/** `mcp__<server>__<tool>` splits at the first `__` so tool names may contain `__`. */
function translateAllowedTool(entry: string): string {
  if (!entry.startsWith("mcp__")) return entry;
  const rest = entry.slice("mcp__".length);
  const split = rest.indexOf("__");
  if (split <= 0 || split + 2 >= rest.length) return entry;
  return `mcp:${rest.slice(0, split)}:${rest.slice(split + 2)}`;
}

/**
 * Reads declared tool refs from `metadata.pizza-bot-tools`, else legacy
 * top-level `tools`/`mcp`, unioned with translated `allowed-tools`. Entries
 * outside the ref vocabulary are kept so readiness reports the skill
 * unavailable rather than granting it fewer tools than it asked for.
 */
export function parseDeclaredTools(frontmatter: Record<string, unknown>): string[] {
  const metadataTools = metadataField(frontmatter, TOOLS_METADATA_KEY);
  const base = listItems(
    metadataTools !== undefined ? metadataTools : frontmatter.tools ?? frontmatter.mcp,
    /[,\s]+/,
  );
  const allowed = allowedToolItems(frontmatter["allowed-tools"]).map(translateAllowedTool);
  return [...new Set([...base, ...allowed])];
}

const HITL_DECISIONS = new Set<HitlDecision>(ALL_INTERRUPT_DECISIONS);

function validDecisions(decisions: readonly unknown[]): HitlDecision[] {
  return decisions.filter(
    (decision): decision is HitlDecision =>
      typeof decision === "string" && HITL_DECISIONS.has(decision as HitlDecision),
  );
}

/**
 * Reads per-tool HITL policy from `metadata.pizza-bot-interrupt-on`
 * (`ref` or `ref=approve,reject`), else legacy top-level `interruptOn`.
 * Invalid refs are ignored; an unusable decision list falls back to the default.
 */
export function parseSkillInterruptOn(frontmatter: Record<string, unknown>): SkillInterruptOn {
  const metadataPolicy = metadataField(frontmatter, INTERRUPT_ON_METADATA_KEY);
  if (metadataPolicy !== undefined) return parseInterruptOnRefs(metadataPolicy);
  const raw = frontmatter.interruptOn;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed: SkillInterruptOn = {};
  for (const [ref, config] of Object.entries(raw)) {
    if (!interruptToolRefSchema.safeParse(ref).success) continue;
    if (typeof config === "boolean") {
      parsed[ref] = config;
      continue;
    }
    const decisions = config && typeof config === "object" && !Array.isArray(config)
      ? (config as { allowedDecisions?: unknown }).allowedDecisions
      : undefined;
    parsed[ref] = { allowedDecisions: decisionsOrDefault(Array.isArray(decisions) ? decisions : []) };
  }
  return parsed;
}

/** A ref named for approval keeps it even when its decision list is unusable. */
function decisionsOrDefault(decisions: readonly unknown[]): HitlDecision[] {
  const valid = validDecisions(decisions);
  return valid.length > 0 ? valid : [...DEFAULT_INTERRUPT_DECISIONS];
}

function parseInterruptOnRefs(raw: unknown): SkillInterruptOn {
  const parsed: SkillInterruptOn = {};
  for (const item of listItems(raw, /\s+/)) {
    const split = item.indexOf("=");
    const ref = split < 0 ? item : item.slice(0, split);
    if (!interruptToolRefSchema.safeParse(ref).success) continue;
    parsed[ref] = {
      allowedDecisions: decisionsOrDefault(split < 0 ? [] : item.slice(split + 1).split(",")),
    };
  }
  return parsed;
}

/**
 * Produces deterministic StateBackend file entries. Unknown skill IDs are
 * ignored because their providing plugin may not be installed.
 */
export function collectSkillFiles(
  ids: readonly string[] | undefined,
  catalog: SkillCatalog | undefined,
): Record<string, SkillFileDataV2> {
  const out: Record<string, SkillFileDataV2> = {};
  if (!ids?.length || !catalog) return out;
  for (const id of [...new Set(ids)].sort()) {
    const entry = catalog.get(id);
    if (!entry) continue;
    for (const file of entry.files) {
      out[file.path] = normalizeSkillFile(file);
    }
  }
  return out;
}

/** Normalize legacy line arrays and infer the MIME type used by DeepAgents V2. */
export function normalizeSkillFile(file: SkillFile): SkillFileDataV2 {
  const content = Array.isArray(file.content) ? file.content.join("\n") : file.content;
  return {
    content: content instanceof Uint8Array ? new Uint8Array(content) : content,
    mimeType: file.mimeType ?? skillMimeType(file.path, content instanceof Uint8Array),
  };
}

/** MIME inference mirrors the runtime's text-by-default policy. */
export function skillMimeType(path: string, binary = false): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return BINARY_SKILL_MIME_TYPES[extension] ?? (binary ? "application/octet-stream" : "text/plain");
}

export function isBinarySkillMimeType(mimeType: string): boolean {
  return !(
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "image/svg+xml"
  );
}

/**
 * Returns deterministic, deduplicated backend paths for resolvable skills.
 * Resolution must match {@link collectSkillFiles} so every path has seeded data.
 */
export function collectSkillPaths(
  ids: readonly string[] | undefined,
  catalog: SkillCatalog | undefined,
): string[] {
  if (!ids?.length || !catalog) return [];
  const paths: string[] = [];
  for (const id of [...new Set(ids)].sort()) {
    if (catalog.has(id)) paths.push(`${SKILLS_ROOT}/${id}/`);
  }
  return paths;
}
