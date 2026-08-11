import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { TriggerStore } from "./triggers.js";

const tmpFiles: string[] = [];
const openHandles: Database.Database[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-triggers-"));
  tmpFiles.push(dir);
  return path.join(dir, "app.sqlite");
}
function openTriggerStore(p: string): TriggerStore {
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  openHandles.push(db);
  return new TriggerStore(db);
}
afterEach(() => {
  for (const db of openHandles.splice(0)) db.close();
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("TriggerStore: CRUD", () => {
  it("creates, gets, and round-trips every kind's fields", () => {
    const s = openTriggerStore(tmpDb());
    const cron = s.create({
      id: "t1",
      kind: "cron",

      prompt: "daily standup",
      enabled: true,
      cron: "0 9 * * *",
    });
    expect(cron.createdAt).toBeTypeOf("string");
    expect(s.get("t1")).toEqual(cron);

    s.create({
      id: "t2",
      kind: "webhook",

      enabled: true,
      webhookSecret: "s3cr3t",
    });
    expect(s.get("t2")?.webhookSecret).toBeUndefined();
    expect(s.get("t2")?.hasWebhookSecret).toBe(true);
    expect(s.verifyWebhookSecret("t2", "s3cr3t")).toBe(true);
    expect(s.verifyWebhookSecret("t2", "wrong")).toBe(false);
    expect(s.get("t2")?.prompt).toBeUndefined();

    const disabled = s.create({
      id: "t3",
      kind: "webhook",
      enabled: false,
      webhookSecret: "another-secret",
    });
    expect(disabled.enabled).toBe(false);
    s.close();
  });

  it("lists newest-first and filters enabled by kind", () => {
    const s = openTriggerStore(tmpDb());
    s.create({ id: "a", kind: "cron", enabled: true, cron: "* * * * *", createdAt: "2026-01-01T00:00:00Z" });
    s.create({ id: "b", kind: "cron", enabled: false, cron: "* * * * *", createdAt: "2026-02-01T00:00:00Z" });
    s.create({ id: "c", kind: "webhook", enabled: true, webhookSecret: "k", createdAt: "2026-03-01T00:00:00Z" });

    expect(s.list().map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(s.listEnabled("cron").map((t) => t.id)).toEqual(["a"]);
    expect(s.listEnabled().map((t) => t.id).sort()).toEqual(["a", "c"]);
    s.close();
  });

  it("patches a subset while preserving id/createdAt", () => {
    const s = openTriggerStore(tmpDb());
    const t = s.create({ id: "t", kind: "cron", enabled: true, cron: "* * * * *" });
    const upd = s.update("t", { enabled: false, prompt: "changed" });
    expect(upd?.enabled).toBe(false);
    expect(upd?.prompt).toBe("changed");
    expect(upd?.createdAt).toBe(t.createdAt);
    expect(s.get("t")?.enabled).toBe(false);
    expect(s.update("missing", { enabled: true })).toBeUndefined();
    s.close();
  });

  it("preserves and rotates hashed webhook secrets without returning them", () => {
    const s = openTriggerStore(tmpDb());
    s.create({ id: "t", kind: "webhook", enabled: true, webhookSecret: "old" });
    s.update("t", { prompt: "preserve secret" });
    expect(s.verifyWebhookSecret("t", "old")).toBe(true);

    const updated = s.update("t", { webhookSecret: "new" });
    expect(updated?.webhookSecret).toBeUndefined();
    expect(updated?.hasWebhookSecret).toBe(true);
    expect(s.verifyWebhookSecret("t", "old")).toBe(false);
    expect(s.verifyWebhookSecret("t", "new")).toBe(true);
  });

  it("deletes and reports whether a row was removed", () => {
    const s = openTriggerStore(tmpDb());
    s.create({ id: "t", kind: "webhook", enabled: true, webhookSecret: "k" });
    expect(s.delete("t")).toBe(true);
    expect(s.get("t")).toBeUndefined();
    expect(s.delete("t")).toBe(false);
    s.close();
  });

  it("survives reopen (durable source of truth)", () => {
    const file = tmpDb();
    const db1 = new Database(file);
    db1.pragma("journal_mode = WAL");
    new TriggerStore(db1).create({ id: "t", kind: "cron", enabled: true, cron: "0 * * * *" });
    db1.close();
    const s2 = openTriggerStore(file);
    expect(s2.get("t")?.cron).toBe("0 * * * *");
  });

});

describe("TriggerStore: durable occurrences", () => {
  it("uses a partial scheduled-at index for recovery scans", () => {
    const db = new Database(tmpDb());
    openHandles.push(db);
    new TriggerStore(db);

    const plan = db
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM trigger_occurrences
         WHERE status IN ('pending', 'running')
         ORDER BY scheduled_at ASC`,
      )
      .all();

    expect(plan.map((step) => step.detail).join(" ")).toContain(
      "USING INDEX idx_trigger_occurrences_recoverable",
    );
  });

  it("deduplicates a cron occurrence for the same scheduled tick", () => {
    const s = openTriggerStore(tmpDb());
    s.create({ id: "t", kind: "cron", enabled: true, cron: "0 * * * *" });
    const input = {
      id: "occ_1",
      triggerId: "t",
      scheduledAt: "2026-07-05T10:00:00.000Z",
      reason: "cron" as const,
      now: "2026-07-05T10:00:00.000Z",
    };
    expect(s.createOccurrence(input).created).toBe(true);
    const duplicate = s.createOccurrence({ ...input, id: "occ_duplicate" });
    expect(duplicate.created).toBe(false);
    expect(duplicate.occurrence.id).toBe("occ_1");
    s.close();
  });

  it("does not deduplicate independent manual or webhook invocations", () => {
    const s = openTriggerStore(tmpDb());
    s.create({
      id: "t",
      kind: "webhook",

      enabled: true,
      webhookSecret: "secret",
    });
    const shared = {
      triggerId: "t",
      scheduledAt: "2026-07-05T10:00:00.000Z",
      now: "2026-07-05T10:00:00.000Z",
    };

    expect(
      s.createOccurrence({ ...shared, id: "manual-1", reason: "manual" }).created,
    ).toBe(true);
    expect(
      s.createOccurrence({ ...shared, id: "manual-2", reason: "manual" }).created,
    ).toBe(true);
    expect(
      s.createOccurrence({ ...shared, id: "webhook-1", reason: "webhook" }).created,
    ).toBe(true);
    expect(
      s.createOccurrence({ ...shared, id: "webhook-2", reason: "webhook" }).created,
    ).toBe(true);
    s.close();
  });

  it("advances an occurrence through its running and terminal lifecycle", () => {
    const s = openTriggerStore(tmpDb());
    s.create({ id: "t", kind: "cron", enabled: true, cron: "0 * * * *" });
    s.createOccurrence({
      id: "occ",
      triggerId: "t",
      scheduledAt: "2026-07-05T10:00:00.000Z",
      reason: "cron",
      now: "2026-07-05T10:00:00.000Z",
    });
    const begun = s.beginOccurrence("occ", "2026-07-05T10:00:01.000Z", 3);
    expect(begun).toMatchObject({ status: "running", attempt: 1 });
    s.attachRun("occ", "thread", "run", "running", "2026-07-05T10:00:01.000Z");
    expect(s.getOccurrence("occ")).toMatchObject({ status: "running", runId: "run" });
    expect(s.get("t")).toMatchObject({ lastRunAt: "2026-07-05T10:00:01.000Z", lastThreadId: "thread" });

    const completed = s.completeOccurrenceByRunId(
      "run",
      "success",
      "2026-07-05T10:00:10.000Z",
    );
    expect(completed).toMatchObject({ status: "succeeded", runStatus: "success" });
    expect(s.occurrences("t")).toEqual([
      expect.objectContaining({ id: "occ", runId: "run", status: "succeeded" }),
    ]);
    s.close();
  });

  it("recovers a crash-orphaned occurrence exactly once until its budget is spent", () => {
    const s = openTriggerStore(tmpDb());
    s.create({ id: "t", kind: "cron", enabled: true, cron: "0 * * * *" });
    s.createOccurrence({
      id: "occ",
      triggerId: "t",
      scheduledAt: "2026-07-05T10:00:00.000Z",
      reason: "cron",
      now: "2026-07-05T10:00:00.000Z",
    });
    // A crash left it running; recovery lists it and re-begins.
    s.beginOccurrence("occ", "2026-07-05T10:00:01.000Z", 1);
    s.attachRun("occ", "thread", "run", "running", "2026-07-05T10:00:01.000Z");
    expect(s.listRecoverableOccurrences().map((o) => o.id)).toEqual(["occ"]);

    // The budget of 1 is already spent, so the next begin kills it.
    expect(s.beginOccurrence("occ", "2026-07-05T10:01:00.000Z", 1)).toBeUndefined();
    expect(s.getOccurrence("occ")).toMatchObject({ status: "dead", attempt: 1 });
    expect(s.listRecoverableOccurrences()).toHaveLength(0);
    s.close();
  });
});
