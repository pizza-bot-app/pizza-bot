/** Durable user-defined folders for organizing thread metadata. */
import Database from "better-sqlite3";

export interface FolderRecord {
  folderId: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

interface FolderRow {
  folder_id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface NewFolderInput {
  folderId: string;
  name: string;
  sortOrder?: number;
  createdAt?: string;
}

export type FolderPatch = Partial<Pick<FolderRecord, "name" | "sortOrder">>;

export class FolderStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        folder_id  TEXT PRIMARY KEY,
        name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_folders_sort
        ON folders (sort_order, name);
    `);
  }

  list(): FolderRecord[] {
    return this.db
      .prepare<[], FolderRow>("SELECT * FROM folders ORDER BY sort_order, name COLLATE NOCASE")
      .all()
      .map(toFolder);
  }

  get(folderId: string): FolderRecord | undefined {
    const row = this.db
      .prepare<[string], FolderRow>("SELECT * FROM folders WHERE folder_id = ?")
      .get(folderId);
    return row ? toFolder(row) : undefined;
  }

  create(input: NewFolderInput): FolderRecord {
    const sortOrder =
      input.sortOrder ??
      (
        this.db
          .prepare<[], { next: number }>(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM folders",
          )
          .get()?.next ?? 0
      );
    const record: FolderRecord = {
      folderId: input.folderId,
      name: input.name,
      sortOrder,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO folders (folder_id, name, sort_order, created_at)
         VALUES (@folder_id, @name, @sort_order, @created_at)`,
      )
      .run(toRow(record));
    this.emit();
    return record;
  }

  update(folderId: string, patch: FolderPatch): FolderRecord | undefined {
    const current = this.get(folderId);
    if (!current) return undefined;
    const updated = { ...current, ...patch, folderId, createdAt: current.createdAt };
    this.db
      .prepare(
        `UPDATE folders
         SET name = @name, sort_order = @sort_order
         WHERE folder_id = @folder_id`,
      )
      .run(toRow(updated));
    this.emit();
    return updated;
  }

  /** Deleting a folder preserves its threads as unfiled. */
  delete(folderId: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare("UPDATE threads SET folder_id = NULL WHERE folder_id = ?").run(folderId);
      return this.db.prepare("DELETE FROM folders WHERE folder_id = ?").run(folderId).changes > 0;
    });
    const deleted = remove();
    if (deleted) this.emit();
    return deleted;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function toFolder(row: FolderRow): FolderRecord {
  return {
    folderId: row.folder_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function toRow(record: FolderRecord): FolderRow {
  return {
    folder_id: record.folderId,
    name: record.name,
    sort_order: record.sortOrder,
    created_at: record.createdAt,
  };
}
