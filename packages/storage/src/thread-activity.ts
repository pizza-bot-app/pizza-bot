import Database from "better-sqlite3";
import type {
  ApprovalDecision,
  ApprovalVerdict,
  ApprovalVerdictSpan,
  ThreadActivityEvent,
  ThreadActivityOutcome,
} from "@pizza-bot/core";

interface ThreadActivityRow {
  seq: number;
  event_id: string;
  thread_id: string;
  run_id: string;
  outcome: string;
  interrupt_ids: string;
  thread_title: string;
  created_at: string;
}

export interface AppendThreadActivity {
  eventId: string;
  threadId: string;
  runId: string;
  outcome: ThreadActivityOutcome;
  interruptIds?: string[];
  threadTitle: string;
  createdAt?: string;
}

const RETAINED_EVENTS = 5_000;

export class ThreadActivityStore {
  private readonly listeners = new Set<(event: ThreadActivityEvent) => void>();

  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_activity_events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id      TEXT NOT NULL UNIQUE,
        thread_id     TEXT NOT NULL,
        run_id        TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        interrupt_ids TEXT NOT NULL,
        thread_title  TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_activity_events_thread
        ON thread_activity_events (thread_id, seq);
    `);
  }

  append(input: AppendThreadActivity): {
    event: ThreadActivityEvent;
    created: boolean;
  } {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_activity_events
           (event_id, thread_id, run_id, outcome, interrupt_ids, thread_title, created_at)
         VALUES
           (@event_id, @thread_id, @run_id, @outcome, @interrupt_ids, @thread_title, @created_at)`,
      )
      .run({
        event_id: input.eventId,
        thread_id: input.threadId,
        run_id: input.runId,
        outcome: input.outcome,
        interrupt_ids: JSON.stringify(input.interruptIds ?? []),
        thread_title: input.threadTitle,
        created_at: createdAt,
      });
    const event = this.byEventId(input.eventId);
    if (!event) throw new Error(`failed to append thread activity ${input.eventId}`);
    if (result.changes === 1) {
      this.prune();
      for (const listener of this.listeners) listener(event);
    }
    return { event, created: result.changes === 1 };
  }

  latestSeq(): number {
    const row = this.db
      .prepare<[], { seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM thread_activity_events",
      )
      .get();
    return row?.seq ?? 0;
  }

  listAfter(seq: number, limit = 500): ThreadActivityEvent[] {
    return this.db
      .prepare<[number, number], ThreadActivityRow>(
        `SELECT * FROM thread_activity_events
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(seq, limit)
      .map(toThreadActivity);
  }

  subscribe(listener: (event: ThreadActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  deleteByThread(threadId: string): number {
    return this.db
      .prepare<[string]>(
        "DELETE FROM thread_activity_events WHERE thread_id = ?",
      )
      .run(threadId).changes;
  }

  private byEventId(eventId: string): ThreadActivityEvent | undefined {
    const row = this.db
      .prepare<[string], ThreadActivityRow>(
        "SELECT * FROM thread_activity_events WHERE event_id = ?",
      )
      .get(eventId);
    return row ? toThreadActivity(row) : undefined;
  }

  private prune(): void {
    const cutoff = this.latestSeq() - RETAINED_EVENTS;
    if (cutoff <= 0) return;
    this.db
      .prepare("DELETE FROM thread_activity_events WHERE seq <= ?")
      .run(cutoff);
  }
}

function toThreadActivity(row: ThreadActivityRow): ThreadActivityEvent {
  let interruptIds: string[] = [];
  try {
    const parsed = JSON.parse(row.interrupt_ids) as unknown;
    if (Array.isArray(parsed)) {
      interruptIds = parsed.filter(
        (value): value is string => typeof value === "string",
      );
    }
  } catch {
    // Corrupt optional IDs do not make the terminal event unreadable.
  }
  return {
    seq: row.seq,
    eventId: row.event_id,
    threadId: row.thread_id,
    runId: row.run_id,
    outcome: row.outcome as ThreadActivityOutcome,
    interruptIds,
    threadTitle: row.thread_title,
    createdAt: row.created_at,
  };
}

interface ApprovalVerdictRow {
  seq: number;
  verdict_id: string;
  thread_id: string;
  run_id: string;
  interrupt_id: string;
  tool_name: string;
  decision: string;
  args: string | null;
  spans: string;
  created_at: string;
}

export interface AppendApprovalVerdict {
  /** Stable per approved action, so a retried resume cannot double-record it. */
  verdictId: string;
  threadId: string;
  runId: string;
  interruptId: string;
  toolName: string;
  decision: ApprovalDecision;
  args?: unknown;
  spans: readonly ApprovalVerdictSpan[];
  createdAt?: string;
}

/**
 * What the server proved about an action's citations at the moment a human approved
 * it. Rows outlive the evidence bodies their spans were audited against, and nothing
 * but a thread deletion removes them.
 */
export class ApprovalVerdictStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_verdicts (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        verdict_id   TEXT NOT NULL UNIQUE,
        thread_id    TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        decision     TEXT NOT NULL,
        args         TEXT,
        spans        TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_verdicts_thread
        ON approval_verdicts (thread_id, seq);
    `);
  }

  append(input: AppendApprovalVerdict): {
    verdict: ApprovalVerdict;
    created: boolean;
  } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO approval_verdicts
           (verdict_id, thread_id, run_id, interrupt_id, tool_name, decision, args, spans, created_at)
         VALUES
           (@verdict_id, @thread_id, @run_id, @interrupt_id, @tool_name, @decision, @args, @spans, @created_at)`,
      )
      .run({
        verdict_id: input.verdictId,
        thread_id: input.threadId,
        run_id: input.runId,
        interrupt_id: input.interruptId,
        tool_name: input.toolName,
        decision: input.decision,
        args: input.args === undefined ? null : JSON.stringify(input.args),
        spans: JSON.stringify(input.spans),
        created_at: input.createdAt ?? new Date().toISOString(),
      });
    const verdict = this.byVerdictId(input.verdictId);
    if (!verdict) throw new Error(`failed to append approval verdict ${input.verdictId}`);
    return { verdict, created: result.changes === 1 };
  }

  /** Oldest first, so a thread's approvals read in the order the reviewer made them. */
  listByThread(threadId: string): ApprovalVerdict[] {
    return this.db
      .prepare<[string], ApprovalVerdictRow>(
        "SELECT * FROM approval_verdicts WHERE thread_id = ? ORDER BY seq ASC",
      )
      .all(threadId)
      .map(toApprovalVerdict);
  }

  deleteByThread(threadId: string): number {
    return this.db
      .prepare<[string]>("DELETE FROM approval_verdicts WHERE thread_id = ?")
      .run(threadId).changes;
  }

  private byVerdictId(verdictId: string): ApprovalVerdict | undefined {
    const row = this.db
      .prepare<[string], ApprovalVerdictRow>(
        "SELECT * FROM approval_verdicts WHERE verdict_id = ?",
      )
      .get(verdictId);
    return row ? toApprovalVerdict(row) : undefined;
  }
}

function toApprovalVerdict(row: ApprovalVerdictRow): ApprovalVerdict {
  let spans: ApprovalVerdictSpan[] = [];
  try {
    const parsed = JSON.parse(row.spans) as unknown;
    if (Array.isArray(parsed)) spans = parsed as ApprovalVerdictSpan[];
  } catch {
    // A corrupt span list must not hide the fact that this action was approved.
  }
  let args: unknown;
  if (row.args !== null) {
    try {
      args = JSON.parse(row.args);
    } catch {
      // Same: unreadable arguments leave the tiers, which are the verdict itself.
    }
  }
  return {
    seq: row.seq,
    verdictId: row.verdict_id,
    threadId: row.thread_id,
    runId: row.run_id,
    interruptId: row.interrupt_id,
    toolName: row.tool_name,
    decision: row.decision as ApprovalDecision,
    ...(args === undefined ? {} : { args }),
    spans,
    createdAt: row.created_at,
  };
}
