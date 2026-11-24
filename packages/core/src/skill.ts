/** Pure Agent Skill types and the read-only `/skills/` backend projection helpers. */

export const SKILLS_ROOT = "/skills";

export const SKILL_MD = "SKILL.md";

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

/**
 * Rebuilds spec-compliant frontmatter from the canonical name, optional display
 * name, and description. Surrounding body whitespace is normalized for
 * idempotent saves.
 */
export function composeSkillMd(
  name: string,
  description: string,
  body: string,
  displayName?: string,
): string {
  const metadataBlock = displayName && displayName !== name
    ? `metadata:\n  display-name: ${JSON.stringify(displayName)}\n`
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
  /** The skill folder is a symlink; it is read-only here and edited at `linkTarget`. */
  linked?: boolean;
  linkTarget?: string;
  files: SkillFile[];
}

export type SkillCatalog = Map<string, SkillCatalogEntry>;

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: SkillCatalogEntry["source"];
  overrides?: NonNullable<SkillCatalogEntry["overrides"]>;
  pluginName?: string;
  linked?: boolean;
  linkTarget?: string;
  enabled?: boolean;
  /** Agents that mount this skill; an unclaimed enabled skill belongs to the orchestrator. */
  usedBy?: string[];
}

export function skillInfoOf(entry: SkillCatalogEntry): SkillInfo {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    ...(entry.overrides ? { overrides: entry.overrides } : {}),
    ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
    ...(entry.linked ? { linked: true } : {}),
    ...(entry.linkTarget ? { linkTarget: entry.linkTarget } : {}),
  };
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
