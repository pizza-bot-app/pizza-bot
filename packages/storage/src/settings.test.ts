import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "@pizza-bot/core";
import { openAppDatabase } from "./app-db.js";
import { SettingsStore } from "./settings.js";

const tmpDirs: string[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-settings-"));
  tmpDirs.push(dir);
  return path.join(dir, "app.sqlite");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("returns the defaults when nothing has been written", () => {
    const app = openAppDatabase(":memory:");
    expect(app.settings.get()).toEqual(DEFAULT_SETTINGS);
    app.close();
  });

  it("patch writes a key and reflects it in a subsequent get", () => {
    const app = openAppDatabase(":memory:");
    const after = app.settings.patch({ theme: "light" });
    expect(after.theme).toBe("light");
    expect(app.settings.get().theme).toBe("light");
    app.close();
  });

  it("patch upserts (updates in place) rather than duplicating a key", () => {
    const app = openAppDatabase(":memory:");
    app.settings.patch({ theme: "light" });
    app.settings.patch({ theme: "system" });
    expect(app.settings.get().theme).toBe("system");
    const rows = app.db.prepare("SELECT COUNT(*) AS n FROM app_settings").get() as { n: number };
    expect(rows.n).toBe(1);
    app.close();
  });

  it("an empty patch is a no-op and leaves existing values intact", () => {
    const app = openAppDatabase(":memory:");
    app.settings.patch({ theme: "light" });
    expect(app.settings.patch({}).theme).toBe("light");
    app.close();
  });

  it("persists the persona addendum independently of the theme", () => {
    const app = openAppDatabase(":memory:");
    app.settings.patch({ customPromptAddendum: "Be concise." });
    expect(app.settings.get().customPromptAddendum).toBe("Be concise.");
    // A theme-only patch must leave the persona intact.
    app.settings.patch({ theme: "light" });
    expect(app.settings.get().customPromptAddendum).toBe("Be concise.");
    app.close();
  });

  it("persists the boolean feature flags independently", () => {
    const app = openAppDatabase(":memory:");
    expect(app.settings.get().enableMemories).toBe(false);
    app.settings.patch({ enableMemories: true });
    expect(app.settings.get().enableMemories).toBe(true);
    // A theme-only patch must leave the flag intact.
    app.settings.patch({ theme: "light" });
    expect(app.settings.get().enableMemories).toBe(true);
    expect(app.settings.get().enableAutomations).toBe(false);
    app.close();
  });

  it("persists the tool-call limit independently", () => {
    const app = openAppDatabase(":memory:");
    app.settings.patch({ maxToolCalls: -1 });
    expect(app.settings.get().maxToolCalls).toBe(-1);
    app.settings.patch({ theme: "light" });
    expect(app.settings.get().maxToolCalls).toBe(-1);
    app.close();
  });

  it("falls back to the default persona for an over-long stored value", () => {
    const app = openAppDatabase(":memory:");
    const tooLong = "x".repeat(8001);
    app.db
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('customPromptAddendum', @v, 'now')")
      .run({ v: JSON.stringify(tooLong) });
    expect(app.settings.get().customPromptAddendum).toBe(DEFAULT_SETTINGS.customPromptAddendum);
    app.close();
  });

  it("falls back to the default for a corrupt stored value", () => {
    const app = openAppDatabase(":memory:");
    app.db
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('theme', '\"neon\"', 'now')")
      .run();
    expect(app.settings.get().theme).toBe(DEFAULT_SETTINGS.theme);
    app.close();
  });

  it("falls back to the default for an invalid stored tool-call limit", () => {
    const app = openAppDatabase(":memory:");
    app.db
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('maxToolCalls', '0', 'now')")
      .run();
    expect(app.settings.get().maxToolCalls).toBe(DEFAULT_SETTINGS.maxToolCalls);
    app.close();
  });

  it("persists across a reopen of the same db file", () => {
    const file = tmpDb();
    const first = openAppDatabase(file);
    first.settings.patch({ theme: "light" });
    first.close();

    const second = openAppDatabase(file);
    expect(second.settings.get().theme).toBe("light");
    second.close();
  });

  it("close() is a no-op — the shared handle stays open", () => {
    const db = openAppDatabase(":memory:").db;
    new SettingsStore(db).close();
    expect(db.open).toBe(true);
    db.close();
  });
});
