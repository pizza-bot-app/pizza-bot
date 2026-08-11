/** Stores installation-owned enablement overrides for skills and MCP servers. */
import Database from "better-sqlite3";

export type CapabilityKind = "skill" | "mcp";

export interface CapabilityPreferenceKey {
  kind: CapabilityKind;
  source: string;
  id: string;
}

interface CapabilityPreferenceRow {
  enabled: number;
}

export class CapabilityPreferencesStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_preferences (
        kind       TEXT NOT NULL,
        source     TEXT NOT NULL,
        id         TEXT NOT NULL,
        enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, source, id)
      );
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  get(key: CapabilityPreferenceKey): boolean | undefined {
    const row = this.db
      .prepare<CapabilityPreferenceKey, CapabilityPreferenceRow>(
        `SELECT enabled
         FROM capability_preferences
         WHERE kind = @kind AND source = @source AND id = @id`,
      )
      .get(key);
    return row ? row.enabled === 1 : undefined;
  }

  set(key: CapabilityPreferenceKey, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO capability_preferences (kind, source, id, enabled, updated_at)
         VALUES (@kind, @source, @id, @enabled, @updated_at)
         ON CONFLICT(kind, source, id)
         DO UPDATE SET enabled = @enabled, updated_at = @updated_at`,
      )
      .run({
        ...key,
        enabled: enabled ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
  }

  delete(key: CapabilityPreferenceKey): void {
    this.db
      .prepare(
        `DELETE FROM capability_preferences
         WHERE kind = @kind AND source = @source AND id = @id`,
      )
      .run(key);
  }

  deleteSource(source: string): void {
    this.db
      .prepare(`DELETE FROM capability_preferences WHERE source = ?`)
      .run(source);
  }
}
