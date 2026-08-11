/** Durable trigger definitions and their occurrence work-queue. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import type {
  TriggerDef,
  TriggerOccurrence,
  TriggerOccurrenceReason,
  TriggerKind,
  RunStatus,
} from "@pizza-bot/core";

interface TriggerRow {
  id: string;
  kind: string;
  prompt: string | null;
  enabled: number;
  cron: string | null;
  timezone: string | null;
  webhook_secret: string | null;
  created_at: string;
  last_run_at: string | null;
  last_thread_id: string | null;
}

interface TriggerOccurrenceRow {
  id: string;
  trigger_id: string;
  scheduled_at: string;
  reason: string;
  status: string;
  attempt: number;
  prompt_override: string | null;
  thread_id: string | null;
  run_id: string | null;
  run_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type TriggerPatch = Partial<Omit<TriggerDef, "id" | "createdAt">>;

export interface CreateTriggerOccurrence {
  id: string;
  triggerId: string;
  scheduledAt: string;
  reason: TriggerOccurrenceReason;
  now: string;
  promptOverride?: string;
}

export class TriggerStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        prompt         TEXT,
        enabled        INTEGER NOT NULL DEFAULT 1,
        cron           TEXT,
        timezone       TEXT,
        webhook_secret TEXT,
        created_at     TEXT NOT NULL,
        last_run_at    TEXT,
        last_thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS trigger_occurrences (
        id              TEXT PRIMARY KEY,
        trigger_id      TEXT NOT NULL,
        scheduled_at    TEXT NOT NULL,
        reason          TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempt         INTEGER NOT NULL DEFAULT 0,
        prompt_override TEXT,
        thread_id       TEXT,
        run_id          TEXT,
        run_status      TEXT,
        last_error      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_occurrences_trigger
        ON trigger_occurrences (trigger_id, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_trigger_occurrences_recoverable
        ON trigger_occurrences (scheduled_at)
        WHERE status IN ('pending', 'running');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_occurrences_cron_schedule
        ON trigger_occurrences (trigger_id, scheduled_at)
        WHERE reason IN ('cron', 'cron-recovery');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_occurrences_run
        ON trigger_occurrences (run_id)
        WHERE run_id IS NOT NULL;
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  create(def: Omit<TriggerDef, "createdAt"> & { createdAt?: string }): TriggerDef {
    const createdAt = def.createdAt ?? new Date().toISOString();
    const row: TriggerRow = {
      id: def.id,
      kind: def.kind,
      prompt: def.prompt ?? null,
      enabled: def.enabled === false ? 0 : 1,
      cron: def.cron ?? null,
      timezone: def.timezone ?? null,
      webhook_secret: def.webhookSecret ? hashSecret(def.webhookSecret) : null,
      created_at: createdAt,
      last_run_at: def.lastRunAt ?? null,
      last_thread_id: def.lastThreadId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO triggers
           (id, kind, prompt, enabled, cron, timezone, webhook_secret,
            created_at, last_run_at, last_thread_id)
         VALUES
           (@id, @kind, @prompt, @enabled, @cron, @timezone, @webhook_secret,
            @created_at, @last_run_at, @last_thread_id)`,
      )
      .run(row);
    return toTrigger(row);
  }

  list(): TriggerDef[] {
    const rows = this.db
      .prepare<[], TriggerRow>("SELECT * FROM triggers ORDER BY created_at DESC")
      .all();
    return rows.map(toTrigger);
  }

  listEnabled(kind?: TriggerKind): TriggerDef[] {
    const rows = kind
      ? this.db
          .prepare<[string], TriggerRow>(
            "SELECT * FROM triggers WHERE enabled = 1 AND kind = ? ORDER BY created_at DESC",
          )
          .all(kind)
      : this.db
          .prepare<[], TriggerRow>("SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at DESC")
          .all();
    return rows.map(toTrigger);
  }

  get(id: string): TriggerDef | undefined {
    const row = this.db.prepare<[string], TriggerRow>("SELECT * FROM triggers WHERE id = ?").get(id);
    return row ? toTrigger(row) : undefined;
  }

  update(id: string, patch: TriggerPatch): TriggerDef | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const merged: TriggerDef = { ...current, ...patch, id, createdAt: current.createdAt };
    const currentSecret = this.db
      .prepare<[string], { webhook_secret: string | null }>(
        "SELECT webhook_secret FROM triggers WHERE id = ?",
      )
      .get(id)?.webhook_secret;
    this.db
      .prepare(
        `UPDATE triggers SET
           kind = @kind, prompt = @prompt, enabled = @enabled,
           cron = @cron, timezone = @timezone, webhook_secret = @webhook_secret,
           last_run_at = @last_run_at, last_thread_id = @last_thread_id
         WHERE id = @id`,
      )
      .run({
        id,
        kind: merged.kind,
        prompt: merged.prompt ?? null,
        enabled: merged.enabled === false ? 0 : 1,
        cron: merged.cron ?? null,
        timezone: merged.timezone ?? null,
        webhook_secret:
          patch.webhookSecret !== undefined
            ? hashSecret(patch.webhookSecret)
            : (currentSecret ?? null),
        last_run_at: merged.lastRunAt ?? null,
        last_thread_id: merged.lastThreadId ?? null,
      });
    return this.get(id);
  }

  verifyWebhookSecret(id: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const stored = this.db
      .prepare<[string], { webhook_secret: string | null }>(
        "SELECT webhook_secret FROM triggers WHERE id = ?",
      )
      .get(id)?.webhook_secret;
    return stored ? verifySecret(stored, presented) : false;
  }

  delete(id: string): boolean {
    const info = this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
    return info.changes > 0;
  }

  createOccurrence(input: CreateTriggerOccurrence): {
    occurrence: TriggerOccurrence;
    created: boolean;
  } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO trigger_occurrences
           (id, trigger_id, scheduled_at, reason, status, attempt, prompt_override,
            created_at, updated_at)
         VALUES
           (@id, @trigger_id, @scheduled_at, @reason, 'pending', 0, @prompt_override,
            @created_at, @updated_at)`,
      )
      .run({
        id: input.id,
        trigger_id: input.triggerId,
        scheduled_at: input.scheduledAt,
        reason: input.reason,
        prompt_override: input.promptOverride ?? null,
        created_at: input.now,
        updated_at: input.now,
      });
    const occurrence =
      this.getOccurrence(input.id) ??
      (input.reason === "cron" || input.reason === "cron-recovery"
        ? this.findScheduledOccurrence(input.triggerId, input.scheduledAt)
        : undefined);
    if (!occurrence) throw new Error(`failed to create trigger occurrence ${input.id}`);
    return { occurrence, created: result.changes === 1 };
  }

  getOccurrence(id: string): TriggerOccurrence | undefined {
    const row = this.db
      .prepare<[string], TriggerOccurrenceRow>(
        "SELECT * FROM trigger_occurrences WHERE id = ?",
      )
      .get(id);
    return row ? rowToOccurrence(row) : undefined;
  }

  occurrences(triggerId: string, limit = 50): TriggerOccurrence[] {
    return this.db
      .prepare<[string, number], TriggerOccurrenceRow>(
        "SELECT * FROM trigger_occurrences WHERE trigger_id = ? ORDER BY scheduled_at DESC LIMIT ?",
      )
      .all(triggerId, limit)
      .map(rowToOccurrence);
  }

  private findScheduledOccurrence(
    triggerId: string,
    scheduledAt: string,
  ): TriggerOccurrence | undefined {
    const row = this.db
      .prepare<[string, string], TriggerOccurrenceRow>(
        `SELECT * FROM trigger_occurrences
         WHERE trigger_id = ? AND scheduled_at = ?
           AND reason IN ('cron', 'cron-recovery')`,
      )
      .get(triggerId, scheduledAt);
    return row ? rowToOccurrence(row) : undefined;
  }

  findOccurrenceByRunId(runId: string): TriggerOccurrence | undefined {
    const row = this.db
      .prepare<[string], TriggerOccurrenceRow>(
        "SELECT * FROM trigger_occurrences WHERE run_id = ?",
      )
      .get(runId);
    return row ? rowToOccurrence(row) : undefined;
  }

  /** Occurrences left mid-flight by a crashed process, replayed once on startup. */
  listRecoverableOccurrences(): TriggerOccurrence[] {
    return this.db
      .prepare<[], TriggerOccurrenceRow>(
        `SELECT * FROM trigger_occurrences
         WHERE status IN ('pending', 'running')
         ORDER BY scheduled_at ASC`,
      )
      .all()
      .map(rowToOccurrence);
  }

  /**
   * Reserve an occurrence for launch, advancing the crash-recovery attempt
   * budget. Kills it once the budget is exhausted so a poison occurrence can't
   * loop forever.
   */
  beginOccurrence(
    id: string,
    now: string,
    maxAttempts: number,
  ): TriggerOccurrence | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare<[string], TriggerOccurrenceRow>(
          "SELECT * FROM trigger_occurrences WHERE id = ?",
        )
        .get(id);
      if (!row) return undefined;
      if (row.status !== "pending" && row.status !== "running") return undefined;
      if (row.attempt >= maxAttempts) {
        this.db
          .prepare(
            `UPDATE trigger_occurrences
             SET status = 'dead', last_error = 'maximum recovery attempts exceeded',
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(now, id);
        return undefined;
      }
      this.db
        .prepare(
          `UPDATE trigger_occurrences
           SET status = 'running', attempt = attempt + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, id);
      return this.getOccurrence(id);
    }).immediate();
  }

  /**
   * Bind the reserved run id/thread to a running occurrence and advance the
   * trigger's recovery metadata, so a crash before the launcher returns still
   * leaves a row that recovery can resume.
   */
  attachRun(
    id: string,
    threadId: string,
    runId: string,
    runStatus: RunStatus,
    now: string,
  ): TriggerOccurrence | undefined {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE trigger_occurrences
           SET thread_id = ?, run_id = ?, run_status = ?, updated_at = ?, last_error = NULL
           WHERE id = ? AND status = 'running'`,
        )
        .run(threadId, runId, runStatus, now, id);
      if (changed.changes !== 1) return undefined;
      const occurrence = this.getOccurrence(id);
      if (!occurrence) return undefined;
      this.db
        .prepare("UPDATE triggers SET last_run_at = ?, last_thread_id = ? WHERE id = ?")
        .run(now, threadId, occurrence.triggerId);
      return occurrence;
    }).immediate();
  }

  completeOccurrenceByRunId(
    runId: string,
    runStatus: RunStatus,
    now: string,
  ): TriggerOccurrence | undefined {
    return this.db.transaction(() => {
      const occurrence = this.findOccurrenceByRunId(runId);
      if (!occurrence) return undefined;
      const status = runStatus === "success" ? "succeeded" : "failed";
      this.db
        .prepare(
          `UPDATE trigger_occurrences
           SET status = ?, run_status = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, runStatus, now, occurrence.id);
      return this.getOccurrence(occurrence.id);
    }).immediate();
  }

  failOccurrence(id: string, error: string, now: string): void {
    this.db
      .prepare(
        `UPDATE trigger_occurrences
         SET status = 'failed', run_status = 'error', last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(error, now, id);
  }

  killOccurrence(id: string, error: string, now: string): void {
    this.db
      .prepare(
        `UPDATE trigger_occurrences
         SET status = 'dead', last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(error, now, id);
  }
}

function toTrigger(row: TriggerRow): TriggerDef {
  const def: TriggerDef = {
    id: row.id,
    kind: row.kind as TriggerKind,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
  if (row.prompt !== null) def.prompt = row.prompt;
  if (row.cron !== null) def.cron = row.cron;
  if (row.timezone !== null) def.timezone = row.timezone;
  if (row.webhook_secret !== null) def.hasWebhookSecret = true;
  if (row.last_run_at !== null) def.lastRunAt = row.last_run_at;
  if (row.last_thread_id !== null) def.lastThreadId = row.last_thread_id;
  return def;
}

function rowToOccurrence(row: TriggerOccurrenceRow): TriggerOccurrence {
  const occurrence: TriggerOccurrence = {
    id: row.id,
    triggerId: row.trigger_id,
    scheduledAt: row.scheduled_at,
    reason: row.reason as TriggerOccurrence["reason"],
    status: row.status as TriggerOccurrence["status"],
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.prompt_override !== null) occurrence.promptOverride = row.prompt_override;
  if (row.thread_id !== null) occurrence.threadId = row.thread_id;
  if (row.run_id !== null) occurrence.runId = row.run_id;
  if (row.run_status !== null) occurrence.runStatus = row.run_status as RunStatus;
  if (row.last_error !== null) occurrence.lastError = row.last_error;
  return occurrence;
}

const SECRET_PREFIX = "sha256";

function isHashedSecret(secret: string): boolean {
  return secret.startsWith(`${SECRET_PREFIX}$`);
}

function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  // Webhook secrets are high-entropy bearer tokens; a fast salted digest
  // avoids storing plaintext without adding password-KDF cost to public calls.
  const digest = createHash("sha256").update(salt).update(secret, "utf8").digest();
  return `${SECRET_PREFIX}$${salt.toString("base64")}$${digest.toString("base64")}`;
}

function verifySecret(stored: string, presented: string): boolean {
  if (!isHashedSecret(stored)) return false;
  const [, saltValue, digestValue] = stored.split("$");
  if (!saltValue || !digestValue) return false;
  const expected = Buffer.from(digestValue, "base64");
  if (expected.length !== 32) return false;
  const actual = createHash("sha256")
    .update(Buffer.from(saltValue, "base64"))
    .update(presented, "utf8")
    .digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
