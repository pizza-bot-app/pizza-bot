import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ThreadStore } from "./threads.js";

const tmpFiles: string[] = [];
const openHandles: Database.Database[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-threads-"));
  tmpFiles.push(dir);
  return path.join(dir, "app.sqlite");
}
function openThreadStore(p: string): ThreadStore {
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  openHandles.push(db);
  return new ThreadStore(db);
}
afterEach(() => {
  for (const db of openHandles.splice(0)) db.close();
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("ThreadStore: CRUD", () => {
  it("creates a user thread with defaults and round-trips it", () => {
    const s = openThreadStore(tmpDb());
    const t = s.create({ threadId: "th1" });
    expect(t.title).toBe("New conversation");
    expect(t.source).toBe("user");
    expect(t.pinned).toBe(false);
    expect(t.unread).toBe(false);
    expect(t.awaitingAction).toBe(false);
    expect(t.createdAt).toBeTypeOf("string");
    expect(t.parentThreadId).toBeUndefined();
    expect(s.get("th1")).toEqual(t);
    s.close();
  });

  it("records fork parent pointers", () => {
    const s = openThreadStore(tmpDb());
    const fork = s.create({
      threadId: "fork1",
      title: "branch",
      source: "fork",
      parentThreadId: "th1",
      parentCheckpointId: "chk_abc",
    });
    expect(fork.source).toBe("fork");
    expect(fork.parentThreadId).toBe("th1");
    expect(fork.parentCheckpointId).toBe("chk_abc");
    expect(s.get("fork1")?.parentCheckpointId).toBe("chk_abc");
    s.close();
  });

  it("ensure() is idempotent — creates once, returns existing after", () => {
    const s = openThreadStore(tmpDb());
    const a = s.ensure({ threadId: "th1", title: "first" });
    const b = s.ensure({ threadId: "th1", title: "ignored second title" });
    expect(b.title).toBe("first");
    expect(a).toEqual(b);
    expect(s.list()).toHaveLength(1);
    s.close();
  });

  it("lists pinned-first then newest-updated", () => {
    const s = openThreadStore(tmpDb());
    s.create({ threadId: "a", createdAt: "2026-01-01T00:00:00Z" });
    s.create({ threadId: "b", createdAt: "2026-02-01T00:00:00Z" });
    s.create({ threadId: "c", pinned: true, createdAt: "2026-01-15T00:00:00Z" });
    expect(s.list().map((t) => t.threadId)).toEqual(["c", "b", "a"]);
    s.close();
  });

  it("patches metadata without changing activity recency", () => {
    const s = openThreadStore(tmpDb());
    const t = s.create({ threadId: "th1", createdAt: "2020-01-01T00:00:00.000Z" });
    const upd = s.update("th1", { title: "renamed", pinned: true });
    expect(upd?.title).toBe("renamed");
    expect(upd?.pinned).toBe(true);
    expect(upd?.createdAt).toBe(t.createdAt);
    expect(upd?.lastActivityAt).toBe(t.lastActivityAt);
    expect(s.update("missing", { title: "x" })).toBeUndefined();
    s.close();
  });

  it("advances activity recency only when touched", () => {
    const s = openThreadStore(tmpDb());
    s.create({ threadId: "older", createdAt: "2026-01-01T00:00:00.000Z" });
    s.create({ threadId: "newer", createdAt: "2026-02-01T00:00:00.000Z" });

    s.update("older", { unread: true, awaitingAction: true });
    expect(s.list().map((thread) => thread.threadId)).toEqual(["newer", "older"]);

    s.touch("older");
    expect(s.list().map((thread) => thread.threadId)).toEqual(["older", "newer"]);
    s.close();
  });

  it("round-trips the unread flag through update/get/list", () => {
    const s = openThreadStore(tmpDb());
    s.create({ threadId: "th1" });
    expect(s.update("th1", { unread: true })?.unread).toBe(true);
    expect(s.get("th1")?.unread).toBe(true);
    expect(s.list()[0]?.unread).toBe(true);
    expect(s.update("th1", { unread: false })?.unread).toBe(false);
    expect(s.get("th1")?.unread).toBe(false);
    s.close();
  });

  it("round-trips the awaiting-action flag through update/get/list", () => {
    const s = openThreadStore(tmpDb());
    s.create({ threadId: "th1" });
    expect(s.update("th1", { awaitingAction: true })?.awaitingAction).toBe(true);
    expect(s.get("th1")?.awaitingAction).toBe(true);
    expect(s.list()[0]?.awaitingAction).toBe(true);
    expect(s.update("th1", { awaitingAction: false })?.awaitingAction).toBe(false);
    expect(s.get("th1")?.awaitingAction).toBe(false);
    s.close();
  });

  it("pins and updates a conversation model", () => {
    const s = openThreadStore(tmpDb());
    s.create({ threadId: "th1", modelId: "bedrock:sonnet" });
    expect(s.get("th1")?.modelId).toBe("bedrock:sonnet");
    expect(s.update("th1", { modelId: "openai:gpt-5" })?.modelId).toBe("openai:gpt-5");
    expect(s.list()[0]?.modelId).toBe("openai:gpt-5");
    s.close();
  });

  it("publishes thread metadata changes", () => {
    const s = openThreadStore(tmpDb());
    const changes: Array<{ type: string; threadId: string }> = [];
    const unsubscribe = s.subscribe((change) => changes.push(change));

    s.create({ threadId: "th1" });
    s.update("th1", { awaitingAction: true });
    s.touch("th1");
    s.delete("th1");
    unsubscribe();
    s.create({ threadId: "th2" });

    expect(changes).toEqual([
      { type: "upsert", threadId: "th1" },
      { type: "upsert", threadId: "th1" },
      { type: "upsert", threadId: "th1" },
      { type: "delete", threadId: "th1" },
    ]);
    s.close();
  });

  it("deletes and reports whether a row was removed", () => {
    const s = openThreadStore(tmpDb());
    s.create({ threadId: "th1" });
    expect(s.delete("th1")).toBe(true);
    expect(s.get("th1")).toBeUndefined();
    expect(s.delete("th1")).toBe(false);
    s.close();
  });

  it("survives reopen (durable source of truth)", () => {
    const file = tmpDb();
    const db1 = new Database(file);
    db1.pragma("journal_mode = WAL");
    new ThreadStore(db1).create({ threadId: "th1", title: "persisted", source: "fork", parentThreadId: "p" });
    db1.close();
    const s2 = openThreadStore(file);
    const t = s2.get("th1");
    expect(t?.title).toBe("persisted");
    expect(t?.parentThreadId).toBe("p");
  });
});
