import { parseFrontmatter } from "@pizza-bot/plugin-sdk";
import {
  SKILL_MD,
  parseDeclaredTools,
  parseSkillInterruptOn,
  splitSkillMd,
  type SkillInterruptOn,
} from "@pizza-bot/core";
import { ArchiveError, readZipArchive, safeArchivePath, type ArchiveFile } from "./archive.js";

export const MAX_SKILL_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_ARCHIVE_FILES = 256;

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillImportError";
  }
}

export interface ImportedSkillFile {
  path: string;
  content: Uint8Array;
}

export interface ImportedSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  files: ImportedSkillFile[];
  declaredTools: string[];
  interruptOn: SkillInterruptOn;
}

export async function parseSkillArchive(bytes: Uint8Array): Promise<ImportedSkill> {
  const archiveFiles = await readZipFiles(bytes);
  const skillMdFiles = archiveFiles.filter((file) => file.path.split("/").at(-1) === SKILL_MD);
  if (skillMdFiles.length !== 1) {
    throw new SkillImportError(
      "invalid_bundle",
      `The archive must contain exactly one ${SKILL_MD} file.`,
    );
  }

  const skillMdFile = skillMdFiles[0]!;
  const slash = skillMdFile.path.lastIndexOf("/");
  const root = slash < 0 ? "" : skillMdFile.path.slice(0, slash);
  const files = archiveFiles.map((file) => {
    if (root && !file.path.startsWith(`${root}/`)) {
      throw new SkillImportError(
        "invalid_bundle",
        `Archive file "${file.path}" is outside the skill directory.`,
      );
    }
    const path = root ? file.path.slice(root.length + 1) : file.path;
    if (!safeArchivePath(path)) {
      throw new SkillImportError("unsafe_path", `Archive file "${file.path}" has an unsafe path.`);
    }
    return { path, content: new Uint8Array(file.content) };
  });

  let skillMd: string;
  try {
    skillMd = new TextDecoder("utf-8", { fatal: true }).decode(skillMdFile.content);
  } catch {
    throw new SkillImportError("invalid_skill_md", `${SKILL_MD} must be valid UTF-8 text.`);
  }

  const frontmatter = parseFrontmatter(skillMd);
  const rawName = frontmatter.name;
  const rawDescription = frontmatter.description;
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new SkillImportError("invalid_skill_md", `${SKILL_MD} frontmatter must include a name.`);
  }
  if (rawName !== rawName.trim() || rawName.length > 64 || !SKILL_NAME_RE.test(rawName)) {
    throw new SkillImportError(
      "invalid_skill_name",
      "Skill name must be 1-64 lowercase letters, digits, or hyphens, with no leading, trailing, or consecutive hyphens.",
    );
  }
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    throw new SkillImportError(
      "invalid_skill_md",
      `${SKILL_MD} frontmatter must include a description.`,
    );
  }
  const description = rawDescription.trim();
  if (description.length > 1024) {
    throw new SkillImportError(
      "invalid_skill_md",
      `${SKILL_MD} description must be 1-1024 characters.`,
    );
  }

  if (root) {
    const directoryName = root.split("/").at(-1);
    if (directoryName !== rawName) {
      throw new SkillImportError(
        "name_mismatch",
        `Skill directory "${directoryName}" must match the frontmatter name "${rawName}".`,
      );
    }
  }

  const { body } = splitSkillMd(skillMd);
  if (body.trim().length === 0) {
    throw new SkillImportError("invalid_skill_md", `${SKILL_MD} must include Markdown instructions.`);
  }

  return {
    id: rawName,
    name: rawName,
    description,
    body,
    files: files.sort((a, b) =>
      a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path.localeCompare(b.path)
    ),
    declaredTools: parseDeclaredTools(frontmatter),
    interruptOn: parseSkillInterruptOn(frontmatter),
  };
}

async function readZipFiles(bytes: Uint8Array): Promise<ArchiveFile[]> {
  try {
    return await readZipArchive(bytes, {
      maxArchiveBytes: MAX_SKILL_ARCHIVE_BYTES,
      maxUncompressedBytes: MAX_SKILL_UNCOMPRESSED_BYTES,
      maxFiles: MAX_SKILL_ARCHIVE_FILES,
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw new SkillImportError(error.code, error.message);
    throw error;
  }
}
