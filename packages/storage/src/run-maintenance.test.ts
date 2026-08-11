import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openAppDatabase, type AppDatabase } from "./app-db.js";
import { RunMaintenance, previewOf, firstTextByRole, type RunMaintenanceDeps } from "./run-maintenance.js";
import { DEFAULT_TITLE } from "./title.js";
import type { IndexableMessage } from "./search.js";

const ai = (id: string, text: string, extra: Record<string, unknown> = {}): IndexableMessage & {
  getType: () => string;
  additional_kwargs?: Record<string, unknown>;
} => ({ id, getType: () => "ai", content: text, ...extra });
const human = (id: string, text: string): IndexableMessage & { getType: () => string } => ({
  id,
  getType: () => "human",
  content: text,
});

describe("previewOf / firstTextByRole", () => {
  it("previewOf returns the newest visible message, skipping tool/system", () => {
    const msgs: IndexableMessage[] = [
      human("h1", "first question"),
      ai("a1", "the answer"),
      { id: "t1", getType: () => "tool", content: "raw tool json" },
    ];
    expect(previewOf(msgs)).toEqual({ lastMessage: "the answer", lastMessageRole: "ai" });
  });

  it("previewOf truncates a long snippet to one line", () => {
    const long = "x".repeat(300);
    const p = previewOf([human("h1", long)]);
    expect(p.lastMessage!.endsWith("…")).toBe(true);
    expect(p.lastMessage!.length).toBeLessThan(160);
  });

  it("firstTextByRole finds the first text-bearing message of a role", () => {
    const msgs: IndexableMessage[] = [
      { id: "a0", getType: () => "ai", content: "" },
      ai("a1", "real answer"),
    ];
    expect(firstTextByRole(msgs, "ai")).toBe("real answer");
    expect(firstTextByRole(msgs, "human")).toBe("");
  });
});

describe("RunMaintenance", () => {
  let app: AppDatabase;
  let titleCalls: Array<[string, string]>;

  function make(
    messages: IndexableMessage[],
    opts: { title?: string | undefined } = {},
  ): { rm: RunMaintenance; deps: RunMaintenanceDeps } {
    const deps: RunMaintenanceDeps = {
      threadStore: app.threadStore,
      search: app.search,
      getMessages: async () => messages,
      generateTitle: async (u, a) => {
        titleCalls.push([u, a]);
        return opts.title;
      },
    };
    return { rm: new RunMaintenance(deps), deps };
  }

  beforeEach(() => {
    app = openAppDatabase(":memory:");
    titleCalls = [];
  });
  afterEach(() => app.close());

  it("reindexThread ensures a row, indexes for FTS, and refreshes the preview", async () => {
    const messages = [human("h1", "anchovy pizza recipe"), ai("a1", "Here is one.")];
    const { rm } = make(messages);
    await rm.reindexThread("t1");

    const row = app.threadStore.get("t1");
    expect(row).toBeDefined();
    expect(row!.lastMessage).toBe("Here is one.");
    expect(row!.lastMessageRole).toBe("ai");
    expect(app.search.search("anchovy").some((h) => h.threadId === "t1")).toBe(true);
  });

  it("generates a title from the first exchange while the title is still default", async () => {
    app.threadStore.create({ threadId: "t1" });
    const { rm } = make([human("h1", "how do I center a div"), ai("a1", "Use flexbox.")], {
      title: "Centering a div",
    });
    await rm.maybeGenerateTitle("t1");
    expect(titleCalls).toEqual([["how do I center a div", "Use flexbox."]]);
    expect(app.threadStore.get("t1")!.title).toBe("Centering a div");
  });

  it("never overwrites a non-default (user-set / already-generated) title", async () => {
    app.threadStore.create({ threadId: "t1", title: "My Custom Title" });
    const { rm } = make([human("h1", "q"), ai("a1", "a")], { title: "Something Else" });
    await rm.maybeGenerateTitle("t1");
    expect(titleCalls).toHaveLength(0);
    expect(app.threadStore.get("t1")!.title).toBe("My Custom Title");
  });

  it("skips title generation until BOTH sides of the exchange have text", async () => {
    app.threadStore.create({ threadId: "t1" });
    const { rm } = make([human("h1", "just a question, no answer yet")], { title: "Nope" });
    await rm.maybeGenerateTitle("t1");
    expect(titleCalls).toHaveLength(0);
    expect(app.threadStore.get("t1")!.title).toBe(DEFAULT_TITLE);
  });

  it("drops an unusable (empty) model title without saving", async () => {
    app.threadStore.create({ threadId: "t1" });
    const { rm } = make([human("h1", "q"), ai("a1", "a")], { title: "   " });
    await rm.maybeGenerateTitle("t1");
    expect(titleCalls).toHaveLength(1);
    expect(app.threadStore.get("t1")!.title).toBe(DEFAULT_TITLE);
  });

  it("never throws out of a best-effort effect when a callback fails", async () => {
    const before = app.threadStore.create({
      threadId: "t1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const rm = new RunMaintenance({
      threadStore: app.threadStore,
      search: app.search,
      getMessages: async () => {
        throw new Error("checkpoint read failed");
      },
      generateTitle: async () => "unused",
    });
    await expect(rm.onRunEnd("t1")).resolves.toBeUndefined();
    expect(app.threadStore.get("t1")?.lastActivityAt).not.toBe(before.lastActivityAt);
  });
});
