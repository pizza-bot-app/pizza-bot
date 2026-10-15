import { splitFrontmatter } from "@pizza-bot/plugin-sdk";
import {
  SKILL_MD,
  parseDeclaredTools,
  parseSkillInterruptOn,
  splitSkillMd,
  type SkillInterruptOn,
} from "@pizza-bot/core";
import { ArchiveError, readZipArchive, safeArchivePath, type ArchiveFile } from "./archive.js";

export const MAX_SKILL_UPLOAD_BYTES = 20 * 1024 * 1024;
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

export async function parseSkillImport(
  filename: string,
  bytes: Uint8Array,
): Promise<ImportedSkill | SkillImportError> {
  if (bytes.byteLength > MAX_SKILL_UPLOAD_BYTES) {
    return new SkillImportError("file_too_large", "The selected file exceeds the 20 MiB limit.");
  }
  const name = filename.toLowerCase();
  const zipSignature = bytes[0] === 0x50 && bytes[1] === 0x4b && (
    (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08)
  );
  if (zipSignature || name.endsWith(".zip")) return parseSkillArchive(bytes);
  if (name.endsWith(".md") || name.endsWith(".markdown")) {
    return parseSkillDefinition(bytes, [{ path: SKILL_MD, content: bytes }]);
  }
  return new SkillImportError("unsupported_file", "Select a Markdown (.md, .markdown) or ZIP (.zip) file to import.");
}

export async function parseSkillArchive(bytes: Uint8Array): Promise<ImportedSkill | SkillImportError> {
  const archiveFiles = await readZipFiles(bytes);
  if (archiveFiles instanceof SkillImportError) return archiveFiles;
  const skillMdFiles = archiveFiles.filter((file) => file.path.split("/").at(-1) === SKILL_MD);
  if (skillMdFiles.length !== 1) {
    return new SkillImportError(
      "invalid_bundle",
      `The archive must contain exactly one ${SKILL_MD} file.`,
    );
  }

  const skillMdFile = skillMdFiles[0]!;
  const slash = skillMdFile.path.lastIndexOf("/");
  const root = slash < 0 ? "" : skillMdFile.path.slice(0, slash);
  const outsideFile = archiveFiles.find((file) => root && !file.path.startsWith(`${root}/`));
  if (outsideFile) {
    return new SkillImportError(
      "invalid_bundle",
      `Archive file "${outsideFile.path}" is outside the skill directory.`,
    );
  }
  const files = archiveFiles.map((file) => ({
    path: root ? file.path.slice(root.length + 1) : file.path,
    content: new Uint8Array(file.content),
  }));
  const unsafeFile = files.find((file) => !safeArchivePath(file.path));
  if (unsafeFile) {
    return new SkillImportError("unsafe_path", `Archive file "${unsafeFile.path}" has an unsafe path.`);
  }

  return parseSkillDefinition(skillMdFile.content, files);
}

function parseSkillDefinition(
  bytes: Uint8Array,
  files: ImportedSkillFile[],
): ImportedSkill | SkillImportError {
  let skillMd: string;
  try {
    skillMd = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new SkillImportError("invalid_skill_md", `${SKILL_MD} must be valid UTF-8 text.`);
  }

  const { data: frontmatter, error: yamlError } = splitFrontmatter(skillMd);
  const rawName = frontmatter.name;
  const rawDescription = frontmatter.description;
  if (typeof rawName !== "string" || rawName.length === 0) {
    return new SkillImportError(
      "invalid_skill_md",
      yamlError
        ? `${SKILL_MD} frontmatter contains invalid YAML: ${yamlError}`
        : `${SKILL_MD} frontmatter must include a name.`,
    );
  }
  if (rawName !== rawName.trim() || rawName.length > 64 || !SKILL_NAME_RE.test(rawName)) {
    const hyphenatedName = rawName.replaceAll("_", "-");
    const suggestion = rawName.includes("_") && hyphenatedName.length <= 64 && SKILL_NAME_RE.test(hyphenatedName)
      ? ` Try "${hyphenatedName}" instead.`
      : "";
    return new SkillImportError(
      "invalid_skill_name",
      `Skill name must be 1-64 lowercase letters, digits, or hyphens, with no leading, trailing, or consecutive hyphens.${suggestion}`,
    );
  }
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    return new SkillImportError(
      "invalid_skill_md",
      `${SKILL_MD} frontmatter must include a description.`,
    );
  }
  const description = rawDescription.trim();
  if (description.length > 1024) {
    return new SkillImportError(
      "invalid_skill_md",
      `${SKILL_MD} description must be 1-1024 characters; received ${description.length} characters.`,
    );
  }

  const { body } = splitSkillMd(skillMd);
  if (body.trim().length === 0) {
    return new SkillImportError("invalid_skill_md", `${SKILL_MD} must include Markdown instructions.`);
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

async function readZipFiles(bytes: Uint8Array): Promise<ArchiveFile[] | SkillImportError> {
  try {
    return await readZipArchive(bytes, {
      maxArchiveBytes: MAX_SKILL_UPLOAD_BYTES,
      maxUncompressedBytes: MAX_SKILL_UNCOMPRESSED_BYTES,
      maxFiles: MAX_SKILL_ARCHIVE_FILES,
    });
  } catch (error) {
    if (error instanceof ArchiveError) return new SkillImportError(error.code, error.message);
    throw error;
  }
}
