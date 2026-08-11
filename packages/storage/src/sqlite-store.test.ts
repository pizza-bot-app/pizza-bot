import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryStore } from "@langchain/langgraph";
import { SqliteStore } from "./sqlite-store.js";

const tmpFiles: string[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-store-"));
  tmpFiles.push(dir);
  return path.join(dir, "store.sqlite");
}
afterEach(() => {
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("SqliteStore: durability", () => {
  it("persists items across reopen (survives process restart)", async () => {
    const file = tmpDb();
    const s1 = new SqliteStore(file);
    await s1.put(["users", "u1"], "profile", { name: "Ada", score: 9 });
    s1.close();

    const s2 = new SqliteStore(file);
    const item = await s2.get(["users", "u1"], "profile");
    expect(item?.value).toEqual({ name: "Ada", score: 9 });
    s2.close();
  });

  it("returns null for a missing key and after delete", async () => {
    const s = new SqliteStore(tmpDb());
    expect(await s.get(["x"], "nope")).toBeNull();
    await s.put(["x"], "k", { a: 1 });
    await s.delete(["x"], "k");
    expect(await s.get(["x"], "k")).toBeNull();
    s.close();
  });

  it("updates value but preserves createdAt on put-over", async () => {
    const s = new SqliteStore(tmpDb());
    await s.put(["n"], "k", { v: 1 });
    const first = await s.get(["n"], "k");
    await new Promise((r) => setTimeout(r, 5));
    await s.put(["n"], "k", { v: 2 });
    const second = await s.get(["n"], "k");
    expect(second?.value).toEqual({ v: 2 });
    expect(second?.createdAt.getTime()).toBe(first?.createdAt.getTime());
    expect(second!.updatedAt.getTime()).toBeGreaterThanOrEqual(second!.createdAt.getTime());
    s.close();
  });
});

describe("SqliteStore: parity with InMemoryStore", () => {
  async function seed(store: SqliteStore | InMemoryStore) {
    await store.put(["docs"], "a", { type: "report", status: "active", score: 5 });
    await store.put(["docs"], "b", { type: "report", status: "archived", score: 2 });
    await store.put(["docs", "sub"], "c", { type: "note", status: "active", score: 8 });
    await store.put(["other"], "d", { type: "misc", score: 1 });
  }

  it("prefix search matches the same items", async () => {
    const sq = new SqliteStore(tmpDb());
    const mem = new InMemoryStore();
    await seed(sq);
    await seed(mem);
    const keyset = async (s: SqliteStore | InMemoryStore) =>
      (await s.search(["docs"], { limit: 100 })).map((i) => i.namespace.join("/") + ":" + i.key).sort();
    expect(await keyset(sq)).toEqual(await keyset(mem));
    expect(await keyset(sq)).toEqual(["docs/sub:c", "docs:a", "docs:b"]);
    sq.close();
  });

  it("filter operators ($eq/$gt/$in) match the same items", async () => {
    const sq = new SqliteStore(tmpDb());
    const mem = new InMemoryStore();
    await seed(sq);
    await seed(mem);
    const run = async (s: SqliteStore | InMemoryStore, filter: Record<string, unknown>) =>
      (await s.search(["docs"], { filter, limit: 100 })).map((i) => i.key).sort();

    for (const filter of [
      { status: "active" },
      { score: { $gt: 4 } },
      { score: { $gte: 5 } },
      { type: { $in: ["note"] } },
      { status: { $ne: "archived" } },
    ]) {
      expect(await run(sq, filter)).toEqual(await run(mem, filter));
    }
    sq.close();
  });

  it("listNamespaces returns the same namespaces (incl. maxDepth)", async () => {
    const sq = new SqliteStore(tmpDb());
    const mem = new InMemoryStore();
    await seed(sq);
    await seed(mem);
    expect(await sq.listNamespaces()).toEqual(await mem.listNamespaces());
    expect(await sq.listNamespaces({ maxDepth: 1 })).toEqual(await mem.listNamespaces({ maxDepth: 1 }));
    expect(await sq.listNamespaces({ prefix: ["docs"] })).toEqual(
      await mem.listNamespaces({ prefix: ["docs"] }),
    );
    sq.close();
  });

  it("rejects semantic (query) search with a clear error", async () => {
    const sq = new SqliteStore(tmpDb());
    await expect(sq.search(["docs"], { query: "anything" })).rejects.toThrow(/semantic search/);
    sq.close();
  });
});
