import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { EvidenceStore } from "./evidence.js";
import type { NewEvidence } from "@pizza-bot/core";

const tmpDirs: string[] = [];
const openHandles: Database.Database[] = [];

function openStore(maxEntriesPerRun?: number): { store: EvidenceStore; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-evidence-"));
  tmpDirs.push(root);
  const db = new Database(path.join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL");
  openHandles.push(db);
  const dir = path.join(root, "evidence");
  return { store: new EvidenceStore(db, dir, maxEntriesPerRun), dir };
}

function newEvidence(overrides: Partial<NewEvidence> = {}): NewEvidence {
  return {
    threadId: "t1",
    runId: "r1",
    toolRef: "mcp:mail:search",
    breadcrumb: "mcp:mail:search (query: renewal)",
    body: "The renewal date is March 4th.",
    bytes: 29,
    truncated: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const db of openHandles.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("EvidenceStore: record + read", () => {
  it("writes the body to disk and the metadata to SQLite", () => {
    const { store, dir } = openStore();
    const entry = store.record(newEvidence())!;

    expect(entry.id).toMatch(/^ev_[0-9a-f]{32}$/);
    expect(entry.excerpt).toBe("The renewal date is March 4th.");
    expect(entry.truncated).toBe(false);
    expect(fs.readFileSync(path.join(dir, entry.id), "utf8")).toBe(
      "The renewal date is March 4th.",
    );
    expect(store.get(entry.id)).toEqual(entry);
    expect(store.readBody(entry.id)).toBe("The renewal date is March 4th.");
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, entry.id)).mode & 0o777).toBe(0o600);
    }
  });

  it("retains the pre-clip size of a truncated source", () => {
    const { store } = openStore();
    const entry = store.record(newEvidence({ body: "head", bytes: 900_000, truncated: true }))!;
    expect(entry.bytes).toBe(900_000);
    expect(entry.truncated).toBe(true);
  });

  it("refuses to record without a thread to scope the entry to", () => {
    const { store } = openStore();
    expect(store.record(newEvidence({ threadId: "" }))).toBeUndefined();
  });

  it("returns undefined for a missing id rather than throwing", () => {
    const { store } = openStore();
    expect(store.get("ev_nope")).toBeUndefined();
    expect(store.readBody("ev_nope")).toBeUndefined();
  });

  it("lists a thread's evidence oldest first", () => {
    const { store } = openStore();
    const first = store.record(newEvidence({ body: "one" }))!;
    const second = store.record(newEvidence({ body: "two" }))!;
    store.record(newEvidence({ threadId: "other", body: "three" }));

    expect(store.listByThread("t1").map((e) => e.id)).toEqual([first.id, second.id]);
    expect(store.listByThread("other").map((e) => e.excerpt)).toEqual(["three"]);
  });
});

describe("EvidenceStore: caps + cleanup", () => {
  it("stops recording past the per-run cap, leaving later results uncitable", () => {
    const { store } = openStore(2);
    expect(store.record(newEvidence())).toBeDefined();
    expect(store.record(newEvidence())).toBeDefined();
    expect(store.record(newEvidence())).toBeUndefined();
    // The cap is per run, so a new run starts with a fresh budget.
    expect(store.record(newEvidence({ runId: "r2" }))).toBeDefined();
  });

  it("deletes a thread's bodies along with its rows", () => {
    const { store, dir } = openStore();
    const mine = store.record(newEvidence())!;
    const other = store.record(newEvidence({ threadId: "t2" }))!;

    expect(store.deleteByThread("t1")).toBe(1);
    expect(store.get(mine.id)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, mine.id))).toBe(false);
    expect(store.get(other.id)).toBeDefined();
    expect(fs.existsSync(path.join(dir, other.id))).toBe(true);
  });

  it("tolerates a body already missing from disk", () => {
    const { store, dir } = openStore();
    const entry = store.record(newEvidence())!;
    fs.rmSync(path.join(dir, entry.id));
    expect(() => store.deleteByThread("t1")).not.toThrow();
    expect(store.get(entry.id)).toBeUndefined();
  });
});

describe("EvidenceStore: path containment", () => {
  // Ids are server-generated UUIDs, so a hostile one can only arrive by corruption.
  // The guard still has to hold, because `readBody` is reachable from an HTTP route.
  it("refuses to read a body whose id escapes the evidence directory", () => {
    const { store, dir } = openStore();
    const db = openHandles.at(-1)!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "..", "outside.txt"), "secret", "utf8");
    db.prepare(
      `INSERT INTO evidence (id, thread_id, run_id, tool_ref, breadcrumb, excerpt, bytes, truncated, created_at)
       VALUES ('../outside.txt', 't1', 'r1', 'mcp:a:b', 'b', 'e', 6, 0, '2026-01-01T00:00:00.000Z')`,
    ).run();

    expect(() => store.readBody("../outside.txt")).toThrow(/invalid evidence id/);
  });
});
