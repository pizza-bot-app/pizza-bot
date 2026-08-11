/** Hardened ZIP reader shared by skill and plugin imports (zip-bomb, traversal, symlink, and duplicate guards). */
import { Buffer } from "node:buffer";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ArchiveFile {
  path: string;
  content: Buffer;
}

export interface ReadArchiveLimits {
  maxArchiveBytes: number;
  maxUncompressedBytes: number;
  maxFiles: number;
}

/**
 * Reads every regular file from a ZIP buffer, rejecting archives that exceed the
 * given limits or carry unsafe paths, symlinks, or duplicate entries. macOS
 * metadata (`__MACOSX/`, `.DS_Store`) and directory entries are dropped.
 */
export async function readZipArchive(
  bytes: Uint8Array,
  limits: ReadArchiveLimits,
): Promise<ArchiveFile[]> {
  if (bytes.byteLength === 0) {
    throw new ArchiveError("empty_archive", "The ZIP archive is empty.");
  }
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new ArchiveError(
      "archive_too_large",
      `The ZIP archive exceeds the ${formatMiB(limits.maxArchiveBytes)} limit.`,
    );
  }

  const zip = await openZip(Buffer.from(bytes));
  if (zip.entryCount > limits.maxFiles) {
    zip.close();
    throw new ArchiveError(
      "too_many_files",
      `The archive contains more than ${limits.maxFiles} entries.`,
    );
  }

  return new Promise<ArchiveFile[]>((resolve, reject) => {
    const files: ArchiveFile[] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(normalizeZipError(error));
    };

    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(files);
    });
    zip.on("entry", (entry: Entry) => {
      try {
        const path = validateArchivePath(entry.fileName);
        if (isSymlink(entry)) {
          throw new ArchiveError("unsupported_entry", `Archive entry "${path}" is a symbolic link.`);
        }
        if (path.endsWith("/") || isMetadataNoise(path)) {
          zip.readEntry();
          return;
        }
        const collisionKey = path.toLowerCase();
        if (seen.has(collisionKey)) {
          throw new ArchiveError("duplicate_entry", `Archive contains duplicate file "${path}".`);
        }
        seen.add(collisionKey);
        totalSize += entry.uncompressedSize;
        if (totalSize > limits.maxUncompressedBytes) {
          throw new ArchiveError(
            "archive_too_large",
            `Uncompressed contents exceed the ${formatMiB(limits.maxUncompressedBytes)} limit.`,
          );
        }

        zip.openReadStream(entry, (error, stream) => {
          if (error) {
            fail(error);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > entry.uncompressedSize || size > limits.maxUncompressedBytes) {
              stream.destroy(new ArchiveError("invalid_archive", `Invalid size for "${path}".`));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (settled) return;
            files.push({ path, content: Buffer.concat(chunks, size) });
            zip.readEntry();
          });
        });
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) => {
        if (error || !zip) {
          reject(normalizeZipError(error));
          return;
        }
        resolve(zip);
      },
    );
  });
}

function normalizeZipError(error: unknown): ArchiveError {
  if (error instanceof ArchiveError) return error;
  const detail = error instanceof Error ? error.message : "";
  const unsafePath = detail.includes("invalid relative path") || detail.includes("absolute path");
  return new ArchiveError(
    unsafePath ? "unsafe_path" : "invalid_archive",
    unsafePath
      ? "The ZIP archive contains an unsafe file path."
      : "The selected file is not a valid ZIP archive.",
  );
}

function validateArchivePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  ) {
    throw new ArchiveError("unsafe_path", `Archive entry "${value}" has an unsafe path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment, index) =>
    (segment.length === 0 && index !== segments.length - 1) ||
    segment === "." ||
    segment === ".." ||
    hasAsciiControlCharacter(segment)
  )) {
    throw new ArchiveError("unsafe_path", `Archive entry "${value}" has an unsafe path.`);
  }
  return value;
}

/** Bundle-relative path safe to join under an install directory. */
export function safeArchivePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/")
  ) {
    return false;
  }
  return value.split("/").every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !hasAsciiControlCharacter(segment)
  );
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function isSymlink(entry: Entry): boolean {
  const unixMode = entry.externalFileAttributes >>> 16;
  return (unixMode & 0xf000) === 0xa000;
}

function isMetadataNoise(path: string): boolean {
  const segments = path.split("/");
  return segments.includes("__MACOSX") || segments.at(-1) === ".DS_Store";
}

function formatMiB(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}
