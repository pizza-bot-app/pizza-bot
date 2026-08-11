/** Persists provider settings as environment-variable references, never secrets. */
import Database from "better-sqlite3";
import type {
  ProviderConfigPort,
  ProviderModelPreferences,
  SavedProviderConfig,
} from "@pizza-bot/core";

interface ConfigRow {
  provider_id: string;
  config: string;
}

const DEFAULT_MODEL_KEY = "default_model";

export class ProviderConfigStore implements ProviderConfigPort {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_configs (
        provider_id TEXT PRIMARY KEY,
        config      TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_defaults (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_model_preferences (
        provider_id TEXT PRIMARY KEY,
        preferences TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  getConfig(providerId: string): SavedProviderConfig | undefined {
    const row = this.db
      .prepare<[string], ConfigRow>("SELECT provider_id, config FROM provider_configs WHERE provider_id = ?")
      .get(providerId);
    return row ? parseConfig(row.config) : undefined;
  }

  listConfigs(): Record<string, SavedProviderConfig> {
    const rows = this.db
      .prepare<[], ConfigRow>("SELECT provider_id, config FROM provider_configs")
      .all();
    const out: Record<string, SavedProviderConfig> = {};
    for (const { provider_id, config } of rows) {
      const parsed = parseConfig(config);
      // A corrupt provider row must not hide the remaining valid providers.
      if (parsed) out[provider_id] = parsed;
    }
    return out;
  }

  setConfig(providerId: string, config: SavedProviderConfig): void {
    this.db
      .prepare(
        `INSERT INTO provider_configs (provider_id, config, updated_at)
         VALUES (@provider_id, @config, @updated_at)
         ON CONFLICT(provider_id) DO UPDATE SET config = @config, updated_at = @updated_at`,
      )
      .run({
        provider_id: providerId,
        config: JSON.stringify(config),
        updated_at: new Date().toISOString(),
      });
  }

  removeConfig(providerId: string): void {
    this.db.prepare("DELETE FROM provider_configs WHERE provider_id = ?").run(providerId);
  }

  getDefaultModel(): string | undefined {
    const row = this.db
      .prepare<[string], { value: string }>("SELECT value FROM app_defaults WHERE key = ?")
      .get(DEFAULT_MODEL_KEY);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  setDefaultModel(qualified: string | null): void {
    if (qualified === null) {
      this.db.prepare("DELETE FROM app_defaults WHERE key = ?").run(DEFAULT_MODEL_KEY);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO app_defaults (key, value, updated_at)
         VALUES (@key, @value, @updated_at)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updated_at`,
      )
      .run({ key: DEFAULT_MODEL_KEY, value: JSON.stringify(qualified), updated_at: new Date().toISOString() });
  }

  getModelPreferences(providerId: string): ProviderModelPreferences | undefined {
    const row = this.db
      .prepare<[string], { preferences: string }>(
        "SELECT preferences FROM provider_model_preferences WHERE provider_id = ?",
      )
      .get(providerId);
    return row ? parseModelPreferences(row.preferences) : undefined;
  }

  setModelPreferences(providerId: string, preferences: ProviderModelPreferences): void {
    this.db
      .prepare(
        `INSERT INTO provider_model_preferences (provider_id, preferences, updated_at)
         VALUES (@provider_id, @preferences, @updated_at)
         ON CONFLICT(provider_id) DO UPDATE SET
           preferences = @preferences,
           updated_at = @updated_at`,
      )
      .run({
        provider_id: providerId,
        preferences: JSON.stringify(preferences),
        updated_at: new Date().toISOString(),
      });
  }

  removeModelPreferences(providerId: string): void {
    this.db
      .prepare("DELETE FROM provider_model_preferences WHERE provider_id = ?")
      .run(providerId);
  }
}

function parseConfig(json: string): SavedProviderConfig | undefined {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.method === "string" &&
      parsed.values &&
      typeof parsed.values === "object"
    ) {
      return { method: parsed.method, values: parsed.values as Record<string, string> };
    }
  } catch {
    // Ignore corrupt records.
  }
  return undefined;
}

function parseModelPreferences(json: string): ProviderModelPreferences | undefined {
  try {
    const parsed = JSON.parse(json) as Partial<ProviderModelPreferences>;
    if (
      (parsed.mode === "all" || parsed.mode === "selected") &&
      Array.isArray(parsed.selected) &&
      parsed.selected.every((id) => typeof id === "string")
    ) {
      return { mode: parsed.mode, selected: [...new Set(parsed.selected)] };
    }
  } catch {
    // Ignore corrupt records.
  }
  return undefined;
}
