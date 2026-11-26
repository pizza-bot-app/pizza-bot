/** Durable Todos and their thread links, in the shared app.sqlite handle. */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  Todo,
  TodoAccess,
  TodoCreateInput,
  TodoImportance,
  TodoPatch,
  TodoStep,
  TodoStepInput,
} from "@pizza-bot/core";

interface TodoRow {
  todo_id: string;
  title: string;
  notes: string;
  due_date: string | null;
  importance: string;
  steps_json: string;
  completed: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Inputs are expected to have passed `todoCreateSchema` / `todoPatchSchema`. */
export class TodoStore implements TodoAccess {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        todo_id      TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        notes        TEXT NOT NULL DEFAULT '',
        due_date     TEXT,
        importance   TEXT NOT NULL DEFAULT 'normal',
        steps_json   TEXT NOT NULL DEFAULT '[]',
        completed    INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_todos_order
        ON todos (completed, created_at DESC);
      CREATE TABLE IF NOT EXISTS todo_threads (
        todo_id   TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (todo_id, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_todo_threads_thread
        ON todo_threads (thread_id);
    `);
  }

  /** Incomplete first, newest first within each group. */
  list(options: { includeCompleted?: boolean } = {}): Todo[] {
    const where = options.includeCompleted === false ? "WHERE completed = 0" : "";
    const rows = this.db
      .prepare<[], TodoRow>(
        `SELECT * FROM todos ${where} ORDER BY completed, created_at DESC, todo_id`,
      )
      .all();
    const links = this.linksByTodo();
    return rows.map((row) => toTodo(row, links.get(row.todo_id) ?? []));
  }

  get(id: string): Todo | undefined {
    const row = this.db
      .prepare<[string], TodoRow>("SELECT * FROM todos WHERE todo_id = ?")
      .get(id);
    return row ? toTodo(row, this.threadIdsOf(id)) : undefined;
  }

  create(input: TodoCreateInput): Todo {
    const now = this.now();
    const id = randomUUID();
    const row: TodoRow = {
      todo_id: id,
      title: input.title,
      notes: input.notes ?? "",
      due_date: input.dueDate ?? null,
      importance: input.importance ?? "normal",
      steps_json: JSON.stringify(normalizeSteps(input.steps ?? [], [])),
      completed: 0,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO todos (todo_id, title, notes, due_date, importance, steps_json,
             completed, completed_at, created_at, updated_at)
           VALUES (@todo_id, @title, @notes, @due_date, @importance, @steps_json,
             @completed, @completed_at, @created_at, @updated_at)`,
        )
        .run(row);
      for (const threadId of new Set(input.threadIds ?? [])) this.insertLink(id, threadId, now);
    })();
    this.emit();
    return this.get(id)!;
  }

  update(id: string, patch: TodoPatch): Todo | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const now = this.now();
    const completed = patch.completed ?? current.completed;
    const completedAt = !completed
      ? null
      : current.completed
        ? (current.completedAt ?? now)
        : now;
    const row: TodoRow = {
      todo_id: id,
      title: patch.title ?? current.title,
      notes: patch.notes ?? current.notes,
      due_date: patch.dueDate === undefined ? (current.dueDate ?? null) : patch.dueDate,
      importance: patch.importance ?? current.importance,
      steps_json: JSON.stringify(
        patch.steps ? normalizeSteps(patch.steps, current.steps) : current.steps,
      ),
      completed: completed ? 1 : 0,
      completed_at: completedAt,
      created_at: current.createdAt,
      updated_at: now,
    };
    this.db
      .prepare(
        `UPDATE todos SET title = @title, notes = @notes, due_date = @due_date,
           importance = @importance, steps_json = @steps_json, completed = @completed,
           completed_at = @completed_at, updated_at = @updated_at
         WHERE todo_id = @todo_id`,
      )
      .run(row);
    this.emit();
    return this.get(id);
  }

  delete(id: string): boolean {
    const deleted = this.db.transaction(() => {
      this.db.prepare("DELETE FROM todo_threads WHERE todo_id = ?").run(id);
      return this.db.prepare("DELETE FROM todos WHERE todo_id = ?").run(id).changes > 0;
    })();
    if (deleted) this.emit();
    return deleted;
  }

  linkThread(id: string, threadId: string): Todo | undefined {
    if (!this.get(id)) return undefined;
    const now = this.now();
    const inserted = this.db.transaction(() => {
      const changes = this.insertLink(id, threadId, now);
      if (changes > 0) this.touch(id, now);
      return changes > 0;
    })();
    if (inserted) this.emit();
    return this.get(id);
  }

  unlinkThread(id: string, threadId: string): Todo | undefined {
    if (!this.get(id)) return undefined;
    const removed = this.db.transaction(() => {
      const changes = this.db
        .prepare("DELETE FROM todo_threads WHERE todo_id = ? AND thread_id = ?")
        .run(id, threadId).changes;
      if (changes > 0) this.touch(id, this.now());
      return changes > 0;
    })();
    if (removed) this.emit();
    return this.get(id);
  }

  /** Drops a deleted thread from every Todo; the Todos themselves remain. */
  forgetThread(threadId: string): void {
    const changes = this.db
      .prepare("DELETE FROM todo_threads WHERE thread_id = ?")
      .run(threadId).changes;
    if (changes > 0) this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private insertLink(id: string, threadId: string, now: string): number {
    return this.db
      .prepare(
        "INSERT OR IGNORE INTO todo_threads (todo_id, thread_id, linked_at) VALUES (?, ?, ?)",
      )
      .run(id, threadId, now).changes;
  }

  private touch(id: string, now: string): void {
    this.db.prepare("UPDATE todos SET updated_at = ? WHERE todo_id = ?").run(now, id);
  }

  private threadIdsOf(id: string): string[] {
    return this.db
      .prepare<[string], { thread_id: string }>(
        "SELECT thread_id FROM todo_threads WHERE todo_id = ? ORDER BY linked_at, rowid",
      )
      .all(id)
      .map((row) => row.thread_id);
  }

  private linksByTodo(): Map<string, string[]> {
    const links = new Map<string, string[]>();
    const rows = this.db
      .prepare<[], { todo_id: string; thread_id: string }>(
        "SELECT todo_id, thread_id FROM todo_threads ORDER BY linked_at, rowid",
      )
      .all();
    for (const row of rows) {
      const list = links.get(row.todo_id);
      if (list) list.push(row.thread_id);
      else links.set(row.todo_id, [row.thread_id]);
    }
    return links;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Repeated ids keep their identity; unknown or missing ids get a fresh one. */
function normalizeSteps(input: readonly TodoStepInput[], current: readonly TodoStep[]): TodoStep[] {
  const known = new Set(current.map((step) => step.id));
  const used = new Set<string>();
  return input.map((step) => {
    const id = step.id && known.has(step.id) && !used.has(step.id) ? step.id : randomUUID();
    used.add(id);
    return { id, title: step.title, completed: step.completed ?? false };
  });
}

function toTodo(row: TodoRow, threadIds: string[]): Todo {
  return {
    id: row.todo_id,
    title: row.title,
    notes: row.notes,
    ...(row.due_date ? { dueDate: row.due_date } : {}),
    importance: row.importance === "high" ? "high" : ("normal" satisfies TodoImportance),
    steps: parseSteps(row.steps_json),
    completed: row.completed === 1,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    threadIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSteps(json: string): TodoStep[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((step): TodoStep[] => {
      if (!step || typeof step !== "object") return [];
      const { id, title, completed } = step as Record<string, unknown>;
      return typeof id === "string" && typeof title === "string"
        ? [{ id, title, completed: completed === true }]
        : [];
    });
  } catch {
    return [];
  }
}
