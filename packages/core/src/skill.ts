/** Pure Agent Skill types and StateBackend projection helpers. */
import { z } from "zod";
import type { HitlDecision } from "./protocol-types.js";

export const SKILLS_ROOT = "/skills";

export const SKILL_MD = "SKILL.md";

export const BUILTIN_EVAL_TOOL_REF = "builtin:eval";

export const toolRefSchema = z
  .string()
  .refine(
    (ref) => ref === BUILTIN_EVAL_TOOL_REF || /^mcp:[^:]+:[^:]+$/.test(ref),
    "Tool ref must be builtin:eval or mcp:<server>:<tool> (wildcards allowed)",
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
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1]!, body: raw.slice(match[0].length).replace(/^\r?\n/, "") };
}

/**
 * Rebuilds spec-compliant frontmatter from the canonical name, optional display
 * name, description, and declared tools. Surrounding body whitespace is
 * normalized for idempotent saves.
 */
export function composeSkillMd(
  name: string,
  description: string,
  body: string,
  declaredTools: readonly string[] = [],
  interruptOn: SkillInterruptOn = {},
  displayName?: string,
): string {
  const toolsBlock = declaredTools.length > 0
    ? `tools:\n${declaredTools.map((t) => `  - ${JSON.stringify(t)}`).join("\n")}\n`
    : "";
  const metadataBlock = displayName && displayName !== name
    ? `metadata:\n  display-name: ${JSON.stringify(displayName)}\n`
    : "";
  const interruptEntries = Object.entries(interruptOn);
  const interruptBlock = interruptEntries.length > 0
    ? `interruptOn:\n${interruptEntries.map(([ref, config]) => {
        if (typeof config === "boolean") return `  ${JSON.stringify(ref)}: ${config}`;
        return [
          `  ${JSON.stringify(ref)}:`,
          "    allowedDecisions:",
          ...config.allowedDecisions.map((decision) => `      - ${decision}`),
        ].join("\n");
      }).join("\n")}\n`
    : "";
  const fm =
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n` +
    `${metadataBlock}${toolsBlock}${interruptBlock}---\n`;
  const trimmed = body.replace(/^\r?\n+/, "").replace(/\s+$/, "");
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

/**
 * Reads declared tool references from parsed skill frontmatter. Accepts either
 * `tools:` or `mcp:` (a comma/whitespace string or a list); non-string entries
 * are dropped so a malformed value degrades to "no declared tools", not a throw.
 */
export function parseDeclaredTools(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tools ?? frontmatter.mcp;
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string" && item.trim()) seen.add(item.trim());
  }
  return [...seen];
}

const HITL_DECISIONS = new Set<HitlDecision>(["approve", "edit", "reject", "respond"]);

/** Reads per-tool HITL policy from skill frontmatter. Invalid entries are ignored. */
export function parseSkillInterruptOn(frontmatter: Record<string, unknown>): SkillInterruptOn {
  const raw = frontmatter.interruptOn;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed: SkillInterruptOn = {};
  for (const [ref, config] of Object.entries(raw)) {
    if (!interruptToolRefSchema.safeParse(ref).success) continue;
    if (typeof config === "boolean") {
      parsed[ref] = config;
      continue;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const decisions = (config as { allowedDecisions?: unknown }).allowedDecisions;
    if (!Array.isArray(decisions)) continue;
    const allowedDecisions = decisions.filter(
      (decision): decision is HitlDecision =>
        typeof decision === "string" && HITL_DECISIONS.has(decision as HitlDecision),
    );
    if (allowedDecisions.length > 0) parsed[ref] = { allowedDecisions };
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
