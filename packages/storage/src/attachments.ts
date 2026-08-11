/** Stores attachment metadata in SQLite and bytes under `attachments/<id>`. */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files.js";
import Database from "better-sqlite3";
import {
  attachmentUrl,
  resolveAttachmentMediaType,
  maxBytesForMediaType,
  MAX_ATTACHMENT_BYTES,
  BEDROCK_ATTACHMENT_LIMITS,
  type AttachmentLimits,
  type AttachmentMeta,
  type AttachmentResolver,
  type ResolvedAttachment,
} from "@pizza-bot/core";

interface AttachmentRow {
  id: string;
  thread_id: string | null;
  filename: string;
  media_type: string;
  size_bytes: number;
  /** Relative path only; absolute paths must never be persisted. */
  rel_path: string;
  created_at: string;
}

export interface NewAttachmentInput {
  bytes: Buffer;
  filename: string;
  mediaType: string;
  threadId?: string;
  /** Stable identifier used as the on-disk filename. */
  id: string;
  createdAt?: string;
}

/** Identifies validation failures that callers may map to a 4xx response. */
export class AttachmentValidationError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported_type" | "too_large" | "empty",
  ) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export class AttachmentStore {
  private readonly db: Database.Database;
  private readonly dir: string;
  private readonly limits: AttachmentLimits;

  /** The attachment directory is created lazily on the first write. */
  constructor(db: Database.Database, attachmentsDir: string, limits: AttachmentLimits = BEDROCK_ATTACHMENT_LIMITS) {
    this.db = db;
    this.dir = attachmentsDir;
    this.limits = limits;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT,
        filename    TEXT NOT NULL,
        media_type  TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        rel_path    TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments (thread_id);
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  /**
   * Reject untrusted identifiers that resolve outside the attachment directory.
   * All attachment filesystem access must pass through this check.
   */
  private absPath(id: string): string {
    const abs = path.resolve(this.dir, id);
    const base = path.resolve(this.dir);
    if (abs !== path.join(base, id) || !abs.startsWith(base + path.sep)) {
      throw new AttachmentValidationError(`invalid attachment id: ${id}`, "unsupported_type");
    }
    return abs;
  }

  create(input: NewAttachmentInput): AttachmentMeta {
    const size = input.bytes.byteLength;
    if (size === 0) throw new AttachmentValidationError("empty file", "empty");
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `file too large (${size} bytes; max ${MAX_ATTACHMENT_BYTES})`,
        "too_large",
      );
    }
    // Infer missing or generic browser MIME types without overriding valid types.
    const mediaType = resolveAttachmentMediaType(input.mediaType, input.filename);
    if (!mediaType) {
      throw new AttachmentValidationError(`unsupported file type: ${input.mediaType}`, "unsupported_type");
    }
    const categoryMax = maxBytesForMediaType(mediaType, this.limits);
    if (size > categoryMax) {
      throw new AttachmentValidationError(
        `file too large (${size} bytes; max ${categoryMax} for this type)`,
        "too_large",
      );
    }

    const abs = this.absPath(input.id);
    ensurePrivateDirectory(this.dir);
    fs.writeFileSync(abs, input.bytes);
    ensurePrivateFile(abs);

    const row: AttachmentRow = {
      id: input.id,
      thread_id: input.threadId ?? null,
      filename: input.filename,
      media_type: mediaType,
      size_bytes: size,
      rel_path: input.id,
      created_at: input.createdAt ?? new Date().toISOString(),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO attachments (id, thread_id, filename, media_type, size_bytes, rel_path, created_at)
           VALUES (@id, @thread_id, @filename, @media_type, @size_bytes, @rel_path, @created_at)`,
        )
        .run(row);
    } catch (err) {
      // Keep filesystem bytes and SQLite metadata from diverging.
      fs.rmSync(abs, { force: true });
      throw err;
    }

    return {
      id: row.id,
      url: attachmentUrl(row.id),
      mediaType: row.media_type,
      filename: row.filename,
      sizeBytes: row.size_bytes,
    };
  }

  get(id: string): AttachmentMeta | undefined {
    const row = this.db
      .prepare<[string], AttachmentRow>("SELECT * FROM attachments WHERE id = ?")
      .get(id);
    return row
      ? {
          id: row.id,
          url: attachmentUrl(row.id),
          mediaType: row.media_type,
          filename: row.filename,
          sizeBytes: row.size_bytes,
        }
      : undefined;
  }

  delete(id: string): boolean {
    const row = this.db
      .prepare<[string], AttachmentRow>("SELECT * FROM attachments WHERE id = ?")
      .get(id);
    if (!row) return false;
    try {
      fs.unlinkSync(this.absPath(row.rel_path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return true;
  }

  deleteByThread(threadId: string): number {
    const rows = this.db
      .prepare<[string], AttachmentRow>("SELECT * FROM attachments WHERE thread_id = ?")
      .all(threadId);
    for (const row of rows) {
      try {
        fs.unlinkSync(this.absPath(row.rel_path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    this.db.prepare("DELETE FROM attachments WHERE thread_id = ?").run(threadId);
    return rows.length;
  }

  /** Returns undefined when either the metadata row or blob is missing. */
  readBytes(id: string): Buffer | undefined {
    const meta = this.get(id);
    if (!meta) return undefined;
    const abs = this.absPath(id);
    try {
      return fs.readFileSync(abs);
    } catch {
      return undefined;
    }
  }

  /** Missing blobs resolve to `undefined` so model inlining can omit them. */
  get resolver(): AttachmentResolver {
    return async (id: string): Promise<ResolvedAttachment | undefined> => {
      const meta = this.get(id);
      if (!meta) return undefined;
      const bytes = this.readBytes(id);
      if (!bytes) return undefined;
      return { data: bytes.toString("base64"), mediaType: meta.mediaType, name: meta.filename };
    };
  }
}
