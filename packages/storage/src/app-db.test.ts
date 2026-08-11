import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAppDatabase } from "./app-db.js";

const tmpFiles: string[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-appdb-"));
  tmpFiles.push(dir);
  return path.join(dir, "app.sqlite");
}
afterEach(() => {
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("openAppDatabase: single shared handle", () => {
  it("backs all three stores with the ONE handle it opened", () => {
    const app = openAppDatabase(tmpDb());
    const handleOf = (s: object) => (s as unknown as { db: unknown }).db;
    expect(handleOf(app.triggers)).toBe(app.db);
    expect(handleOf(app.threadStore)).toBe(app.db);
    expect(handleOf(app.search)).toBe(app.db);
    expect(handleOf(app.settings)).toBe(app.db);
    expect(handleOf(app.capabilityPreferences)).toBe(app.db);
    app.close();
  });

  it("restricts the data directory and database to the current user", () => {
    const dbPath = tmpDb();
    const directory = path.dirname(dbPath);
    fs.chmodSync(directory, 0o755);

    const app = openAppDatabase(dbPath);

    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    }
    app.close();
  });

  it("closes the shared handle exactly once (owner owns it)", () => {
    const app = openAppDatabase(tmpDb());
    expect(app.db.open).toBe(true);
    app.triggers.close();
    app.threadStore.close();
    app.search.close();
    expect(app.db.open).toBe(true);
    app.close();
    expect(app.db.open).toBe(false);
  });

  it("lets all three stores coexist + read each other's writes on disk", () => {
    const app = openAppDatabase(tmpDb());
    app.triggers.create({ id: "t1", kind: "cron", enabled: true, cron: "0 * * * *" });
    app.threadStore.create({ threadId: "th1", title: "shared" });
    app.search.reindexThread("th1", [{ id: "m1", content: "shared handle works", getType: () => "human" }]);

    expect(app.triggers.get("t1")?.cron).toBe("0 * * * *");
    expect(app.threadStore.get("th1")?.title).toBe("shared");
    expect(app.search.search("shared").map((h) => h.threadId)).toEqual(["th1"]);
    app.close();
  });

  it(":memory: now shares ONE db so the three stores coexist in-process", () => {
    const app = openAppDatabase(":memory:");
    app.triggers.create({ id: "t1", kind: "webhook", enabled: true, webhookSecret: "s" });
    app.threadStore.create({ threadId: "th1", title: "in-memory" });
    app.search.reindexThread("th1", [{ id: "m1", content: "memory coexistence", getType: () => "ai" }]);

    expect(app.triggers.get("t1")?.hasWebhookSecret).toBe(true);
    expect(app.triggers.verifyWebhookSecret("t1", "s")).toBe(true);
    expect(app.threadStore.get("th1")?.title).toBe("in-memory");
    expect(app.search.search("coexistence")).toHaveLength(1);
    const names = app.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') OR name = 'messages_fts'")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["triggers", "trigger_occurrences", "threads", "messages_fts"]));
    app.close();
  });
});
