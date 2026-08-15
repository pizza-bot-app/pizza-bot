/** Owns the shared app.sqlite handle used by all app-level stores. */
import path from "node:path";
import Database from "better-sqlite3";
import { TriggerStore } from "./triggers.js";
import { ThreadStore } from "./threads.js";
import { SearchStore } from "./search.js";
import { SettingsStore } from "./settings.js";
import { ProviderConfigStore } from "./provider-configs.js";
import { AttachmentStore } from "./attachments.js";
import { ThreadActivityStore } from "./thread-activity.js";
import { CapabilityPreferencesStore } from "./capability-preferences.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files.js";
import { FolderStore } from "./folders.js";

/** `close()` is the sole owner of the shared handle's lifecycle. */
export interface AppDatabase {
  db: Database.Database;
  triggers: TriggerStore;
  threadStore: ThreadStore;
  folders: FolderStore;
  search: SearchStore;
  settings: SettingsStore;
  providerConfigs: ProviderConfigStore;
  threadActivity: ThreadActivityStore;
  capabilityPreferences: CapabilityPreferencesStore;
  /** Attachment metadata is in SQLite; bytes remain in `attachmentsDir`. */
  attachments?: AttachmentStore;
  close(): void;
}

/**
 * All stores share this handle, including in `:memory:` mode. Each store applies
 * its own idempotent schema.
 */
export function openAppDatabase(dbPath: string, attachmentsDir?: string): AppDatabase {
  // better-sqlite3 does not create the parent directory.
  const isMemory = dbPath === ":memory:" || dbPath.startsWith("file::memory:");
  if (!isMemory) ensurePrivateDirectory(path.dirname(dbPath));
  const db = new Database(dbPath);
  if (!isMemory) ensurePrivateFile(dbPath);
  // Configure WAL once on the shared handle.
  db.pragma("journal_mode = WAL");
  const folders = new FolderStore(db);
  return {
    db,
    folders,
    triggers: new TriggerStore(db),
    threadStore: new ThreadStore(db),
    search: new SearchStore(db),
    settings: new SettingsStore(db),
    providerConfigs: new ProviderConfigStore(db),
    threadActivity: new ThreadActivityStore(db),
    capabilityPreferences: new CapabilityPreferencesStore(db),
    ...(attachmentsDir ? { attachments: new AttachmentStore(db, attachmentsDir) } : {}),
    close() {
      db.close();
    },
  };
}
