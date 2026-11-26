import { Hono } from "hono";
import { lstat, mkdir, readdir, readlink, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  SKILL_MD,
  SKILLS_ROOT,
  composeSkillMd,
  isBinarySkillMimeType,
  normalizeSkillFile,
  skillMimeType,
  splitSkillMd,
  type SkillCatalogEntry,
} from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";
import { fileResourceRoutes, type ParseResult } from "./resource-crud.js";
import {
  MAX_SKILL_UPLOAD_BYTES,
  MAX_SKILL_UNCOMPRESSED_BYTES,
  SkillImportError,
  parseSkillImport,
  type ImportedSkill,
} from "./skill-import.js";
import { limitMultipartBody } from "./request-limits.js";

// Bundle files may nest; each "/"-segment is validated and traversal is rejected.
const PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SKILL_JSON_METADATA_BYTES = 1024 * 1024;
export const MAX_SKILL_JSON_BODY_BYTES =
  Math.ceil(MAX_SKILL_UNCOMPRESSED_BYTES * 4 / 3) + SKILL_JSON_METADATA_BYTES;

interface SkillFields {
  name: string;
  description: string;
  body: string;
  files: ParsedSiblingFile[];
}

interface SiblingFile {
  path: string;
  content: string;
  encoding?: "base64";
  mimeType?: string;
}

interface ParsedSiblingFile {
  path: string;
  content: string | Uint8Array;
}

export interface SkillBundleWire {
  id: string;
  name: string;
  description: string;
  body: string;
  files: SiblingFile[];
  source: SkillCatalogEntry["source"];
  overrides?: NonNullable<SkillCatalogEntry["overrides"]>;
  pluginName?: string;
}

function toWire(entry: SkillCatalogEntry): SkillBundleWire {
  const rootPath = `${SKILLS_ROOT}/${entry.id}/${SKILL_MD}`;
  const prefix = `${SKILLS_ROOT}/${entry.id}/`;
  const skillMd = entry.files.find((f) => f.path === rootPath);
  const normalizedSkillMd = skillMd ? normalizeSkillFile(skillMd) : undefined;
  const { body } =
    normalizedSkillMd && typeof normalizedSkillMd.content === "string"
      ? splitSkillMd(normalizedSkillMd.content)
      : { body: "" };
  const files: SiblingFile[] = entry.files
    .filter((f) => f.path !== rootPath)
    .map((f) => {
      const normalized = normalizeSkillFile(f);
      return normalized.content instanceof Uint8Array
        ? {
            path: f.path.slice(prefix.length),
            content: Buffer.from(normalized.content).toString("base64"),
            encoding: "base64" as const,
            mimeType: normalized.mimeType,
          }
        : { path: f.path.slice(prefix.length), content: normalized.content };
    });
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    body,
    files,
    source: entry.source,
    ...(entry.overrides ? { overrides: entry.overrides } : {}),
    ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
  };
}

function parsedToWire(id: string, fields: SkillFields): SkillBundleWire {
  return {
    id,
    name: fields.name,
    description: fields.description,
    body: fields.body,
    files: fields.files.map((file) =>
      file.content instanceof Uint8Array
        ? {
            path: file.path,
            content: Buffer.from(file.content).toString("base64"),
            encoding: "base64",
            mimeType: skillMimeType(file.path, true),
          }
        : { path: file.path, content: file.content },
    ),
    source: "user",
  };
}

function parseBody(raw: unknown): ParseResult<SkillFields> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const description = typeof b.description === "string" ? b.description.trim() : "";
  const body = typeof b.body === "string" ? b.body : "";
  if (!name) return { ok: false, detail: "name is required" };
  if (!description) return { ok: false, detail: "description is required" };

  const files: ParsedSiblingFile[] = [];
  const seen = new Set<string>();
  const rawFiles = Array.isArray(b.files) ? b.files : [];
  for (const f of rawFiles) {
    const rawPath = typeof (f as SiblingFile)?.path === "string" ? (f as SiblingFile).path.trim() : "";
    const wire = f as SiblingFile;
    const content = typeof wire?.content === "string" ? wire.content : "";
    if (!rawPath) continue;
    const path = safeBundlePath(rawPath);
    if (!path) return { ok: false, detail: `unsafe bundle path "${rawPath}"` };
    if (path === SKILL_MD) return { ok: false, detail: `sibling file cannot be named ${SKILL_MD} (use body)` };
    if (seen.has(path)) return { ok: false, detail: `duplicate bundle path "${path}"` };
    seen.add(path);
    if (wire.encoding !== undefined && wire.encoding !== "base64") {
      return { ok: false, detail: `unsupported encoding for bundle path "${path}"` };
    }
    const mimeType = wire.mimeType ?? skillMimeType(path);
    const binary = wire.encoding === "base64" || isBinarySkillMimeType(mimeType);
    if (binary) {
      const bytes = decodeBase64(content);
      if (!bytes) return { ok: false, detail: `invalid base64 content for bundle path "${path}"` };
      files.push({ path, content: bytes });
    } else {
      files.push({ path, content });
    }
  }
  return { ok: true, name, description, body, files };
}

// Nested bundle paths must stay within the bundle: no absolute paths, backslashes,
// "." / ".." segments, or characters outside the segment allowlist.
function safeBundlePath(value: string): string | undefined {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) return undefined;
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || !PATH_SEGMENT_RE.test(segment))
  ) {
    return undefined;
  }
  return segments.join("/");
}

async function writeSkill(
  skillsDir: string,
  id: string,
  fields: SkillFields,
): Promise<void> {
  const dir = join(skillsDir, id);
  // Replacing the bundle removes sibling files omitted by the new definition.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, SKILL_MD),
    composeSkillMd(id, fields.description, fields.body, fields.name),
    "utf8",
  );
  for (const f of fields.files) {
    const destination = resolve(dir, f.path);
    // Defense in depth: parse already rejected traversal, but never escape the bundle.
    if (!destination.startsWith(`${resolve(dir)}${sep}`)) {
      throw new Error(`unsafe bundle path "${f.path}"`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, f.content);
  }
}

async function writeImportedSkill(skillsDir: string, skill: ImportedSkill): Promise<void> {
  const dir = join(skillsDir, skill.id);
  await mkdir(skillsDir, { recursive: true });
  await mkdir(dir, { recursive: false });
  try {
    for (const file of skill.files) {
      const destination = resolve(dir, file.path);
      if (!destination.startsWith(`${resolve(dir)}${sep}`)) {
        throw new Error(`unsafe bundle path "${file.path}"`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function importedToWire(skill: ImportedSkill): SkillBundleWire {
  const files: SiblingFile[] = skill.files
    .filter((file) => file.path !== SKILL_MD)
    .map((file) => {
      const mimeType = skillMimeType(file.path);
      if (!isBinarySkillMimeType(mimeType)) {
        try {
          return {
            path: file.path,
            content: new TextDecoder("utf-8", { fatal: true }).decode(file.content),
          };
        } catch {
          // An unknown extension may still contain opaque binary data.
        }
      }
      return {
        path: file.path,
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64" as const,
        mimeType: isBinarySkillMimeType(mimeType) ? mimeType : "application/octet-stream",
      };
    });
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    files,
    source: "user",
  };
}

function decodeBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s/g, "");
  if (compact.length === 0) return new Uint8Array();
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined;
  const bytes = Buffer.from(compact, "base64");
  const canonical = bytes.toString("base64");
  return canonical === compact ? new Uint8Array(bytes) : undefined;
}

async function userSkillExists(skillsDir: string, id: string): Promise<boolean> {
  const entries = await readdir(join(skillsDir, id)).catch(() => null);
  return entries !== null && entries.includes(SKILL_MD);
}

/** The resolved target when the top-level skill folder is a symlink; such skills are edited at the source. */
async function skillLinkTarget(skillsDir: string, id: string): Promise<string | undefined> {
  const path = join(skillsDir, id);
  const st = await lstat(path).catch(() => null);
  if (!st?.isSymbolicLink()) return undefined;
  return realpath(path).catch(() => readlink(path));
}

function linkedConflict(target: string): Record<string, unknown> {
  return {
    error: "linked",
    detail: `This skill is linked from ${target}; edit it at the source.`,
  };
}

export function skillRoutes(host: AgentHost): Hono {
  const app = fileResourceRoutes<string, SkillFields>({
    base: "/skills",
    disabledError: "skills_disabled",
    container: () => host.skillsDirectory().then((d) => d || null),
    parse: parseBody,
    exists: (skillsDir, id) => userSkillExists(skillsDir, id),
    patchable: (_skillsDir, id) =>
      host.skillFor(id).then((entry) => entry !== undefined && entry.source !== "user"),
    reserved: (_skillsDir, id) => host.skillFor(id).then((e) => Boolean(e)),
    writeConflict: async (skillsDir, id) => {
      const target = await skillLinkTarget(skillsDir, id);
      return target ? linkedConflict(target) : undefined;
    },
    write: (skillsDir, id, parsed) => writeSkill(skillsDir, id, parsed),
    remove: async (skillsDir, id) => {
      const path = join(skillsDir, id);
      // Deleting a linked skill drops only the link; the target is the user's own folder.
      if (await skillLinkTarget(skillsDir, id)) await unlink(path);
      else await rm(path, { recursive: true, force: true });
      host.clearUserSkillPreference(id);
    },
    reload: () => host.reloadSkills(),
    present: async (id, parsed) => {
      const entry = await host.skillFor(id);
      return entry ? toWire(entry) : parsedToWire(id, parsed);
    },
  });

  app.post("/skills/generate", async (c) => {
    if (!(await host.skillsDirectory())) return c.json({ error: "skills_disabled" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length === 0) return c.json({ error: "invalid", detail: "prompt is required" }, 400);
    try {
      return c.json(await host.generateSkillDraft(prompt));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[skills] generate failed:", detail);
      return c.json({ error: "generate_failed", detail }, 500);
    }
  });

  app.put("/skills/:id/enabled", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "invalid", detail: "enabled must be a boolean" }, 400);
    }
    const skill = await host.setSkillEnabled(c.req.param("id"), body.enabled);
    return skill ? c.json(skill) : c.json({ error: "not_found" }, 404);
  });

  app.use("/skills/import", limitMultipartBody(MAX_SKILL_UPLOAD_BYTES));
  app.post("/skills/import", async (c) => {
    const skillsDir = await host.skillsDirectory();
    if (!skillsDir) return c.json({ error: "skills_disabled" }, 409);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "invalid_multipart", detail: "Expected a Markdown or ZIP file upload." }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "missing_file", detail: "Select a Markdown or ZIP file to import." }, 400);
    }
    if (file.size > MAX_SKILL_UPLOAD_BYTES) {
      return c.json({ error: "file_too_large", detail: "The selected file exceeds the 20 MiB limit." }, 413);
    }

    const skill = await parseSkillImport(file.name, new Uint8Array(await file.arrayBuffer()));
    if (skill instanceof SkillImportError) {
      const status = skill.code === "archive_too_large" || skill.code === "file_too_large" ? 413 : 400;
      return c.json({ error: skill.code, detail: skill.message }, status);
    }
    if (await userSkillExists(skillsDir, skill.id)) {
      return c.json(
        { error: "already_exists", detail: `A custom skill named "${skill.id}" already exists.` },
        409,
      );
    }
    if (await host.skillFor(skill.id)) {
      return c.json(
        { error: "reserved_id", detail: `The skill name "${skill.id}" is already in use.` },
        409,
      );
    }
    const linkTarget = await skillLinkTarget(skillsDir, skill.id);
    if (linkTarget) return c.json(linkedConflict(linkTarget), 409);

    await writeImportedSkill(skillsDir, skill);
    // An exported Pizza Bot skill can still carry tool grants; they become an agent.
    await host.adoptSkillToolGrants();
    await host.reloadSkills();
    const entry = await host.skillFor(skill.id);
    return c.json(entry ? toWire(entry) : importedToWire(skill), 201);
  });

  app.get("/skills/:id", async (c) => {
    const entry = await host.skillFor(c.req.param("id"));
    if (!entry) return c.json({ error: "not_found" }, 404);
    return c.json(toWire(entry));
  });

  return app;
}
