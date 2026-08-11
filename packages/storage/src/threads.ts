/** Durable thread metadata; message content remains in the checkpointer. */
import Database from "better-sqlite3";

export type ThreadSource = "user" | "trigger" | "fork";

export interface ThreadRecord {
  threadId: string;
  title: string;
  source: ThreadSource;
  pinned: boolean;
  /** Indicates completed activity that the user has not viewed. */
  unread: boolean;
  /** Indicates a durable HITL pause that requires a user decision. */
  awaitingAction: boolean;
  createdAt: string;
  /** Most recent message or run activity; metadata-only edits do not change it. */
  lastActivityAt: string;
  parentThreadId?: string;
  parentCheckpointId?: string;
  /** Model selected for this conversation; set on its first model turn. */
  modelId?: string;
  lastMessage?: string;
  lastMessageRole?: string;
}

interface ThreadRow {
  thread_id: string;
  title: string;
  parent_thread_id: string | null;
  parent_checkpoint_id: string | null;
  source: string;
  pinned: number;
  unread: number;
  awaiting_action: number;
  model_id: string | null;
  created_at: string;
  last_activity_at: string;
  last_message: string | null;
  last_message_role: string | null;
}

export interface NewThreadInput {
  threadId: string;
  title?: string;
  source?: ThreadSource;
  pinned?: boolean;
  parentThreadId?: string;
  parentCheckpointId?: string;
  modelId?: string;
  createdAt?: string;
}

export type ThreadPatch = Partial<
  Pick<
    ThreadRecord,
    | "title"
    | "source"
    | "pinned"
    | "unread"
    | "awaitingAction"
    | "parentThreadId"
    | "parentCheckpointId"
    | "modelId"
    | "lastMessage"
    | "lastMessageRole"
  >
>;

export class ThreadStore {
  private readonly db: Database.Database;
  private readonly listeners = new Set<(change: ThreadChange) => void>();

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id            TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        parent_thread_id     TEXT,
        parent_checkpoint_id TEXT,
        source               TEXT NOT NULL DEFAULT 'user',
        pinned               INTEGER NOT NULL DEFAULT 0,
        unread               INTEGER NOT NULL DEFAULT 0,
        awaiting_action      INTEGER NOT NULL DEFAULT 0,
        model_id             TEXT,
        created_at           TEXT NOT NULL,
        last_activity_at     TEXT NOT NULL,
        last_message         TEXT,
        last_message_role    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_threads_activity
        ON threads (pinned DESC, last_activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_source  ON threads (source);
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  create(input: NewThreadInput): ThreadRecord {
    const now = input.createdAt ?? new Date().toISOString();
    const rec: ThreadRecord = {
      threadId: input.threadId,
      title: input.title ?? "New conversation",
      source: input.source ?? "user",
      pinned: input.pinned ?? false,
      unread: false,
      awaitingAction: false,
      createdAt: now,
      lastActivityAt: now,
      ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.parentCheckpointId !== undefined
        ? { parentCheckpointId: input.parentCheckpointId }
        : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO threads
           (thread_id, title, parent_thread_id, parent_checkpoint_id, source, pinned, unread,
            awaiting_action, model_id, created_at, last_activity_at, last_message,
            last_message_role)
         VALUES
           (@thread_id, @title, @parent_thread_id, @parent_checkpoint_id, @source, @pinned, @unread,
            @awaiting_action, @model_id, @created_at, @last_activity_at, @last_message,
            @last_message_role)`,
      )
      .run(toRow(rec));
    this.emit({ type: "upsert", threadId: rec.threadId });
    return rec;
  }

  /** Streaming can begin before an explicit create, so callers may ensure lazily. */
  ensure(input: NewThreadInput): ThreadRecord {
    return this.get(input.threadId) ?? this.create(input);
  }

  list(limit = 200): ThreadRecord[] {
    const rows = this.db
      .prepare<[number], ThreadRow>(
        "SELECT * FROM threads ORDER BY pinned DESC, last_activity_at DESC LIMIT ?",
      )
      .all(limit);
    return rows.map(toThread);
  }

  get(threadId: string): ThreadRecord | undefined {
    const row = this.db
      .prepare<[string], ThreadRow>("SELECT * FROM threads WHERE thread_id = ?")
      .get(threadId);
    return row ? toThread(row) : undefined;
  }

  update(threadId: string, patch: ThreadPatch): ThreadRecord | undefined {
    const current = this.get(threadId);
    if (!current) return undefined;
    const merged: ThreadRecord = {
      ...current,
      ...patch,
      threadId,
      createdAt: current.createdAt,
      lastActivityAt: current.lastActivityAt,
    };
    this.db
      .prepare(
        `UPDATE threads SET
           title = @title, parent_thread_id = @parent_thread_id,
           parent_checkpoint_id = @parent_checkpoint_id, source = @source,
           pinned = @pinned, unread = @unread, awaiting_action = @awaiting_action,
           model_id = @model_id,
           last_message = @last_message, last_message_role = @last_message_role
         WHERE thread_id = @thread_id`,
      )
      .run(toRow(merged));
    this.emit({ type: "upsert", threadId });
    return merged;
  }

  touch(threadId: string): void {
    const info = this.db
      .prepare("UPDATE threads SET last_activity_at = ? WHERE thread_id = ?")
      .run(new Date().toISOString(), threadId);
    if (info.changes > 0) this.emit({ type: "upsert", threadId });
  }

  delete(threadId: string): boolean {
    const info = this.db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
    const deleted = info.changes > 0;
    if (deleted) this.emit({ type: "delete", threadId });
    return deleted;
  }

  subscribe(listener: (change: ThreadChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: ThreadChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

export interface ThreadChange {
  type: "upsert" | "delete";
  threadId: string;
}

function toThread(row: ThreadRow): ThreadRecord {
  const rec: ThreadRecord = {
    threadId: row.thread_id,
    title: row.title,
    source: row.source as ThreadSource,
    pinned: row.pinned === 1,
    unread: row.unread === 1,
    awaitingAction: row.awaiting_action === 1,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
  if (row.parent_thread_id !== null) rec.parentThreadId = row.parent_thread_id;
  if (row.parent_checkpoint_id !== null) rec.parentCheckpointId = row.parent_checkpoint_id;
  if (row.model_id !== null) rec.modelId = row.model_id;
  if (row.last_message !== null) rec.lastMessage = row.last_message;
  if (row.last_message_role !== null) rec.lastMessageRole = row.last_message_role;
  return rec;
}

function toRow(rec: ThreadRecord): ThreadRow {
  return {
    thread_id: rec.threadId,
    title: rec.title,
    parent_thread_id: rec.parentThreadId ?? null,
    parent_checkpoint_id: rec.parentCheckpointId ?? null,
    source: rec.source,
    pinned: rec.pinned ? 1 : 0,
    unread: rec.unread ? 1 : 0,
    awaiting_action: rec.awaitingAction ? 1 : 0,
    model_id: rec.modelId ?? null,
    created_at: rec.createdAt,
    last_activity_at: rec.lastActivityAt,
    last_message: rec.lastMessage ?? null,
    last_message_role: rec.lastMessageRole ?? null,
  };
}
