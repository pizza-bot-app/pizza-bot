/** Stores per-install settings as JSON values overlaid on current defaults. */
import Database from "better-sqlite3";
import {
  DEFAULT_SETTINGS,
  isPromptAddendum,
  isThemePreference,
  type AppSettings,
  type AppSettingsPatch,
} from "@pizza-bot/core";

interface SettingRow {
  key: string;
  value: string;
}

export class SettingsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  /** Invalid stored values fall back to `DEFAULT_SETTINGS`. */
  get(): AppSettings {
    const rows = this.db.prepare<[], SettingRow>("SELECT key, value FROM app_settings").all();
    const stored: Record<string, unknown> = {};
    for (const { key, value } of rows) {
      try {
        stored[key] = JSON.parse(value);
      } catch {
        // Ignore corrupt values so the default remains effective.
      }
    }
    return {
      theme: isThemePreference(stored.theme) ? stored.theme : DEFAULT_SETTINGS.theme,
      customPromptAddendum: isPromptAddendum(stored.customPromptAddendum)
        ? stored.customPromptAddendum
        : DEFAULT_SETTINGS.customPromptAddendum,
      enableMemories:
        typeof stored.enableMemories === "boolean"
          ? stored.enableMemories
          : DEFAULT_SETTINGS.enableMemories,
      enableAutomations:
        typeof stored.enableAutomations === "boolean"
          ? stored.enableAutomations
          : DEFAULT_SETTINGS.enableAutomations,
    };
  }

  /** Writes provided keys atomically; undefined fields leave stored values intact. */
  patch(patch: AppSettingsPatch): AppSettings {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updated_at`,
    );
    const writeAll = this.db.transaction((entries: SettingRow[]) => {
      for (const e of entries) upsert.run({ ...e, updated_at: now });
    });

    const entries: SettingRow[] = [];
    if (patch.theme !== undefined) entries.push({ key: "theme", value: JSON.stringify(patch.theme) });
    if (patch.customPromptAddendum !== undefined) {
      entries.push({ key: "customPromptAddendum", value: JSON.stringify(patch.customPromptAddendum) });
    }
    if (patch.enableMemories !== undefined) {
      entries.push({ key: "enableMemories", value: JSON.stringify(patch.enableMemories) });
    }
    if (patch.enableAutomations !== undefined) {
      entries.push({ key: "enableAutomations", value: JSON.stringify(patch.enableAutomations) });
    }
    if (entries.length > 0) writeAll(entries);
    return this.get();
  }
}
