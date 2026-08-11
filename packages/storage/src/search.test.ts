import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SearchStore, messageText, messageRole, type IndexableMessage } from "./search.js";

const tmpFiles: string[] = [];
const openHandles: Database.Database[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-search-"));
  tmpFiles.push(dir);
  return path.join(dir, "app.sqlite");
}
function openSearchStore(p: string): SearchStore {
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  openHandles.push(db);
  return new SearchStore(db);
}
afterEach(() => {
  for (const db of openHandles.splice(0)) db.close();
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function instanceMsg(role: string, text: string, id: string): IndexableMessage {
  return { id, content: text, getType: () => role };
}

function serializedMsg(cls: string, text: string): IndexableMessage {
  return { id: ["langchain", "schema", cls], kwargs: { content: text } };
}

describe("SearchStore: message extraction", () => {
  it("reads text from string and array content", () => {
    expect(messageText({ content: "hello" })).toBe("hello");
    expect(
      messageText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    ).toBe("ab");
    expect(messageText({ kwargs: { content: "serialized" } })).toBe("serialized");
  });

  it("classifies role from getType() and from serialized id[]", () => {
    expect(messageRole({ getType: () => "human" })).toBe("human");
    expect(messageRole({ id: ["x", "AIMessage"] })).toBe("ai");
    expect(messageRole({ id: ["x", "ToolMessage"] })).toBe("tool");
    expect(messageRole({})).toBe("unknown");
  });
});

describe("SearchStore: reindex + search", () => {
  it("indexes a thread and returns matching hits with snippets", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [
      instanceMsg("human", "I want a pepperoni pizza please", "m1"),
      instanceMsg("ai", "Sure, ordering a pepperoni pizza now", "m2"),
    ]);
    const hits = s.search("pepperoni");
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.threadId === "th1")).toBe(true);
    expect(hits[0]!.snippet).not.toContain("<mark>");
    expect(hits[0]!.highlights).toContainEqual({ text: "pepperoni", highlighted: true });
    expect(hits.map((h) => h.messageId).sort()).toEqual(["m1", "m2"]);
    s.close();
  });

  it("returns hostile message markup only as inert structured text", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [
      instanceMsg("human", `<img src=x onerror=alert(1)> pepperoni <script>bad()</script>`, "m1"),
    ]);

    const [hit] = s.search("pepperoni");
    expect(hit?.snippet).toContain("<img src=x onerror=alert(1)>");
    expect(hit?.snippet).toContain("<script>bad()</script>");
    expect(hit?.highlights).toContainEqual({ text: "pepperoni", highlighted: true });
    expect(hit?.highlights.map((part) => part.text).join("")).toBe(hit?.snippet);
    s.close();
  });

  it("preserves control characters in source text without treating them as markers", () => {
    const s = openSearchStore(tmpDb());
    const text = "before \u0001 literal pepperoni \u0002 after";
    s.reindexThread("th1", [instanceMsg("human", text, "m1")]);

    const [hit] = s.search("pepperoni");
    expect(hit?.snippet).toContain("\u0001 literal pepperoni \u0002");
    expect(hit?.highlights.map((part) => part.text).join("")).toBe(hit?.snippet);
    expect(hit?.highlights).toContainEqual({ text: "pepperoni", highlighted: true });
    s.close();
  });

  it("porter-stems so a query term matches an inflected form", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [instanceMsg("ai", "the oven is running hot", "m1")]);
    expect(s.search("run").length).toBe(1);
    s.close();
  });

  it("skips empty/whitespace messages (e.g. tool-call-only AI turns)", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [
      instanceMsg("ai", "   ", "m1"),
      instanceMsg("human", "margherita", "m2"),
    ]);
    const hits = s.search("margherita");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messageId).toBe("m2");
    s.close();
  });

  it("reindex replaces prior rows for the same thread (no dupes/stale)", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [instanceMsg("human", "hawaiian pineapple", "m1")]);
    expect(s.search("pineapple")).toHaveLength(1);
    s.reindexThread("th1", [instanceMsg("human", "plain cheese", "m1")]);
    expect(s.search("pineapple")).toHaveLength(0);
    expect(s.search("cheese")).toHaveLength(1);
    s.close();
  });

  it("scopes hits per thread and tolerates the serialized wire form", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [serializedMsg("HumanMessage", "anchovy special")]);
    s.reindexThread("th2", [serializedMsg("AIMessage", "no anchovy in stock")]);
    const hits = s.search("anchovy");
    expect(hits.map((h) => h.threadId).sort()).toEqual(["th1", "th2"]);
    expect(hits.find((h) => h.threadId === "th2")?.role).toBe("ai");
    s.close();
  });

  it("deleteThread purges only the given thread's rows", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [instanceMsg("human", "keep the calzone", "m1")]);
    s.reindexThread("th2", [instanceMsg("human", "delete the calzone", "m2")]);
    expect(s.search("calzone")).toHaveLength(2);
    s.deleteThread("th1");
    const hits = s.search("calzone");
    expect(hits.map((h) => h.threadId)).toEqual(["th2"]);
    expect(() => s.deleteThread("nope")).not.toThrow();
    expect(s.search("calzone")).toHaveLength(1);
    s.close();
  });

  it("returns nothing for a blank query and never throws on punctuation", () => {
    const s = openSearchStore(tmpDb());
    s.reindexThread("th1", [instanceMsg("human", "double (extra) cheese!", "m1")]);
    expect(s.search("")).toEqual([]);
    expect(s.search("   ")).toEqual([]);
    expect(() => s.search('cheese"() AND')).not.toThrow();
    expect(s.search("cheese").length).toBe(1);
    s.close();
  });
});
