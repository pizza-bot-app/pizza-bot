/**
 * Stores evidence metadata in SQLite and bodies under `evidence/<id>`. Writes come
 * only from the server-side ledger, so an agent cannot forge its own provenance.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files.js";
import {
  evidenceExcerpt,
  MAX_EVIDENCE_ENTRIES_PER_RUN,
  type EvidenceEntry,
  type EvidenceRecorder,
  type NewEvidence,
} from "@pizza-bot/core";

interface EvidenceRow {
  id: string;
  thread_id: string;
  run_id: string;
  tool_ref: string;
  breadcrumb: string;
  excerpt: string;
  bytes: number;
  truncated: number;
  created_at: string;
}

function toEntry(row: EvidenceRow): EvidenceEntry {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    toolRef: row.tool_ref,
    breadcrumb: row.breadcrumb,
    excerpt: row.excerpt,
    bytes: row.bytes,
    truncated: row.truncated === 1,
    createdAt: row.created_at,
  };
}

export class EvidenceStore {
  private readonly db: Database.Database;
  private readonly dir: string;
  private readonly maxEntriesPerRun: number;

  /** The evidence directory is created lazily on the first write. */
  constructor(
    db: Database.Database,
    evidenceDir: string,
    maxEntriesPerRun = MAX_EVIDENCE_ENTRIES_PER_RUN,
  ) {
    this.db = db;
    this.dir = evidenceDir;
    this.maxEntriesPerRun = maxEntriesPerRun;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        tool_ref    TEXT NOT NULL,
        breadcrumb  TEXT NOT NULL,
        excerpt     TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        truncated   INTEGER NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_thread ON evidence (thread_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence (thread_id, run_id);
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  /**
   * Rejects identifiers that resolve outside the evidence directory. All evidence
   * filesystem access must pass through this check.
   */
  private absPath(id: string): string {
    const base = path.resolve(this.dir);
    const abs = path.resolve(base, id);
    if (abs !== path.join(base, id) || !abs.startsWith(base + path.sep)) {
      throw new Error(`invalid evidence id: ${id}`);
    }
    return abs;
  }

  private runCount(threadId: string, runId: string): number {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM evidence WHERE thread_id = ? AND run_id = ?",
      )
      .get(threadId, runId);
    return row?.n ?? 0;
  }

  /** Returns undefined once the run's cap is reached, leaving the output uncitable. */
  record(input: NewEvidence): EvidenceEntry | undefined {
    if (!input.threadId) return undefined;
    if (this.runCount(input.threadId, input.runId) >= this.maxEntriesPerRun) {
      return undefined;
    }
    const row: EvidenceRow = {
      id: `ev_${randomUUID().replaceAll("-", "")}`,
      thread_id: input.threadId,
      run_id: input.runId,
      tool_ref: input.toolRef,
      breadcrumb: input.breadcrumb,
      excerpt: evidenceExcerpt(input.body),
      bytes: input.bytes,
      truncated: input.truncated ? 1 : 0,
      created_at: new Date().toISOString(),
    };

    const abs = this.absPath(row.id);
    ensurePrivateDirectory(this.dir);
    fs.writeFileSync(abs, input.body, "utf8");
    ensurePrivateFile(abs);
    try {
      this.db
        .prepare(
          `INSERT INTO evidence (id, thread_id, run_id, tool_ref, breadcrumb, excerpt, bytes, truncated, created_at)
           VALUES (@id, @thread_id, @run_id, @tool_ref, @breadcrumb, @excerpt, @bytes, @truncated, @created_at)`,
        )
        .run(row);
    } catch (err) {
      // Keep filesystem bodies and SQLite metadata from diverging.
      fs.rmSync(abs, { force: true });
      throw err;
    }
    return toEntry(row);
  }

  get(id: string): EvidenceEntry | undefined {
    const row = this.db
      .prepare<[string], EvidenceRow>("SELECT * FROM evidence WHERE id = ?")
      .get(id);
    return row ? toEntry(row) : undefined;
  }

  /**
   * Oldest first, so an evidence list reads in the order the run gathered it. `rowid`
   * breaks the tie between results recorded in the same millisecond, which the random
   * id cannot.
   */
  listByThread(threadId: string): EvidenceEntry[] {
    return this.db
      .prepare<[string], EvidenceRow>(
        "SELECT * FROM evidence WHERE thread_id = ? ORDER BY created_at, rowid",
      )
      .all(threadId)
      .map(toEntry);
  }

  /**
   * Returns undefined when either the metadata row or the body is missing. A
   * containment violation is not swallowed: it means the id itself is hostile.
   */
  readBody(id: string): string | undefined {
    if (!this.get(id)) return undefined;
    const abs = this.absPath(id);
    try {
      return fs.readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  deleteByThread(threadId: string): number {
    const rows = this.db
      .prepare<[string], EvidenceRow>("SELECT id FROM evidence WHERE thread_id = ?")
      .all(threadId);
    for (const row of rows) {
      try {
        fs.unlinkSync(this.absPath(row.id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    this.db.prepare("DELETE FROM evidence WHERE thread_id = ?").run(threadId);
    return rows.length;
  }

  get recorder(): EvidenceRecorder {
    return async (input: NewEvidence) => this.record(input);
  }
}
