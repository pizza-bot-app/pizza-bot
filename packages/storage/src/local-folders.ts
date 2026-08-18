import type Database from "better-sqlite3";
import {
  LOCAL_FOLDER_VIRTUAL_ROOT,
  type LocalFolder,
} from "@pizza-bot/core";

interface LocalFolderRow {
  id: string;
  label: string;
  path: string;
  read_only: number;
  created_at: string;
}

function fromRow(row: LocalFolderRow): LocalFolder {
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    virtualPath: `${LOCAL_FOLDER_VIRTUAL_ROOT}/${row.id}`,
    readOnly: row.read_only !== 0,
    createdAt: row.created_at,
  };
}

/** Persists backend-host folder grants. */
export class LocalFolderStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_folders (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        read_only  INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
    `);
  }

  list(): LocalFolder[] {
    return this.db
      .prepare<[], LocalFolderRow>(
        "SELECT id, label, path, read_only, created_at FROM local_folders ORDER BY label COLLATE NOCASE, id",
      )
      .all()
      .map(fromRow);
  }

  get(id: string): LocalFolder | undefined {
    const row = this.db
      .prepare<[string], LocalFolderRow>(
        "SELECT id, label, path, read_only, created_at FROM local_folders WHERE id = ?",
      )
      .get(id);
    return row ? fromRow(row) : undefined;
  }

  create(input: {
    id: string;
    label: string;
    path: string;
    readOnly: boolean;
  }): LocalFolder {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO local_folders (id, label, path, read_only, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.id, input.label, input.path, input.readOnly ? 1 : 0, createdAt);
    return this.get(input.id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM local_folders WHERE id = ?").run(id).changes > 0;
  }

  hasPath(path: string): boolean {
    return this.db
      .prepare<[string], { present: number }>(
        "SELECT 1 AS present FROM local_folders WHERE path = ?",
      )
      .get(path) !== undefined;
  }

  hasId(id: string): boolean {
    return this.db
      .prepare<[string], { present: number }>(
        "SELECT 1 AS present FROM local_folders WHERE id = ?",
      )
      .get(id) !== undefined;
  }
}
