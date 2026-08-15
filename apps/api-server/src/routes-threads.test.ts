import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAppDatabase } from "@pizza-bot/storage";
import { threadRoutes, sliceForFork, forkBoundaryError, type ForkMessage } from "./routes-threads.js";

const human = (id: string, text = "hi"): ForkMessage => ({ id, getType: () => "human", content: text } as ForkMessage);
const ai = (id: string, calls: string[] = []): ForkMessage =>
  ({ id, getType: () => "ai", tool_calls: calls.map((cid) => ({ id: cid })) } as ForkMessage);
const tool = (id: string, callId: string): ForkMessage =>
  ({ id, getType: () => "tool", tool_call_id: callId } as ForkMessage);

describe("sliceForFork", () => {
  it("returns [] when the target id is absent", () => {
    expect(sliceForFork([human("a"), ai("b")], "missing")).toEqual([]);
  });

  it("slices inclusively at a plain (non-tool) message", () => {
    const h = [human("a"), ai("b"), human("c")];
    expect(sliceForFork(h, "b").map((m) => m.id)).toEqual(["a", "b"]);
    expect(sliceForFork(h, "a").map((m) => m.id)).toEqual(["a"]);
  });

  it("extends forward to keep an AI tool_call with its ToolMessage result", () => {
    const h = [human("a"), ai("b", ["c1"]), tool("t1", "c1"), ai("d")];
    expect(sliceForFork(h, "b").map((m) => m.id)).toEqual(["a", "b", "t1"]);
  });

  it("keeps ALL results for an AI turn with multiple parallel tool_calls", () => {
    const h = [ai("b", ["c1", "c2"]), tool("t1", "c1"), tool("t2", "c2"), human("z")];
    expect(sliceForFork(h, "b").map((m) => m.id)).toEqual(["b", "t1", "t2"]);
  });

  it("drops a boundary AI turn whose tool_calls can't be resolved (no dangling call)", () => {
    const h = [human("a"), ai("b", ["c1"])];
    expect(sliceForFork(h, "b").map((m) => m.id)).toEqual(["a"]);
  });

  it("drops the boundary AI turn if only SOME parallel calls resolve", () => {
    const h = [ai("b", ["c1", "c2"]), tool("t1", "c1"), human("z")];
    expect(sliceForFork(h, "b").map((m) => m.id)).toEqual([]);
  });

  it("slicing at a ToolMessage keeps the pair intact (target is the result)", () => {
    const h = [human("a"), ai("b", ["c1"]), tool("t1", "c1"), ai("d")];
    expect(sliceForFork(h, "t1").map((m) => m.id)).toEqual(["a", "b", "t1"]);
  });

  it("tolerates the serialized wire form (id[] classnames + kwargs)", () => {
    const h: ForkMessage[] = [
      { kwargs: { id: "a" }, id: ["lc", "HumanMessage"] },
      { kwargs: { id: "b", tool_calls: [{ id: "c1" }] }, id: ["lc", "AIMessage"] },
      { kwargs: { id: "t1", tool_call_id: "c1" }, id: ["lc", "ToolMessage"] },
    ];
    expect(sliceForFork(h, "b").map((m) => (m.kwargs as { id: string }).id)).toEqual(["a", "b", "t1"]);
  });
});

describe("forkBoundaryError (B2: fork only at a completed assistant turn)", () => {
  it("allows forking at a plain assistant turn", () => {
    const h = [human("a"), ai("b"), human("c")];
    expect(forkBoundaryError(h, "b")).toBeNull();
  });

  it("allows forking at an assistant turn whose tool_calls all resolve", () => {
    const h = [human("a"), ai("b", ["c1", "c2"]), tool("t1", "c1"), tool("t2", "c2"), ai("d")];
    expect(forkBoundaryError(h, "b")).toBeNull();
  });

  it("rejects forking at a user message", () => {
    const h = [human("a"), ai("b")];
    expect(forkBoundaryError(h, "a")).toBe("can only fork at a completed assistant turn");
  });

  it("rejects forking at a ToolMessage (mid-turn, not an answer boundary)", () => {
    const h = [human("a"), ai("b", ["c1"]), tool("t1", "c1"), ai("d")];
    expect(forkBoundaryError(h, "t1")).toBe("can only fork at a completed assistant turn");
  });

  it("rejects forking mid-tool-call (unresolved tool_calls)", () => {
    const h = [human("a"), ai("b", ["c1"])];
    expect(forkBoundaryError(h, "b")).toBe("cannot fork mid-tool-call (unresolved tool_calls)");
  });

  it("rejects forking when only some parallel calls resolve", () => {
    const h = [ai("b", ["c1", "c2"]), tool("t1", "c1"), human("z")];
    expect(forkBoundaryError(h, "b")).toBe("cannot fork mid-tool-call (unresolved tool_calls)");
  });

  it("reports a missing id", () => {
    expect(forkBoundaryError([human("a")], "missing")).toBe("messageId not found in thread history");
  });
});


const tmpFiles: string[] = [];
function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-thread-routes-"));
  tmpFiles.push(dir);
  return path.join(dir, "app.sqlite");
}
// Windows keeps a lock on the open SQLite handle (and its WAL sidecars), so the
// db must be closed before the temp dir can be removed.
const openApps: Array<{ close(): void }> = [];
afterEach(() => {
  for (const app of openApps.splice(0)) app.close();
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeHost(history: ForkMessage[], runningThreads: Set<string> = new Set()) {
  const app = openAppDatabase(tmpDb());
  openApps.push(app);
  const { threadStore, search, threadActivity, folders: folderStore } = app;
  let updated: { threadId: string; values: unknown } | undefined;
  const purgedCheckpoints: string[] = [];
  const host = {
    threadStore,
    folderStore,
    search,
    threadActivity,
    persistence: {
      checkpointer: {
        async deleteThread(threadId: string) {
          purgedCheckpoints.push(threadId);
        },
      },
    },
    protocolRuns: {
      isRunning(threadId: string) {
        return runningThreads.has(threadId);
      },
      async discardThread(threadId: string) {
        runningThreads.delete(threadId);
      },
    },
    agent: {
      async getState(threadId: string) {
        return { threadId, checkpointId: "chk_src", values: { messages: history }, next: [], createdAt: "t0" };
      },
      async updateState(threadId: string, values: unknown) {
        updated = { threadId, values };
        return { checkpointId: "chk_new", threadId };
      },
    },
  } as unknown as import("./agent-host.js").AgentHost;
  Object.assign(host, {
    async deleteThread(threadId: string) {
      await host.protocolRuns.discardThread(threadId);
      const deleted = threadStore.delete(threadId);
      search.deleteThread(threadId);
      await host.persistence.checkpointer.deleteThread(threadId);
      return deleted;
    },
  });
  return {
    host,
    threadStore,
    search,
    threadActivity,
    getUpdated: () => updated,
    purgedCheckpoints,
  };
}

describe("threadRoutes: fork", () => {
  it("forks at a message, seeds the new thread, and records parent pointers", async () => {
    const history = [human("a", "want pizza"), ai("b"), human("c", "extra cheese")];
    const { host, getUpdated } = fakeHost(history);
    host.threadStore.create({
      threadId: "src",
      title: "Order",
      modelId: "bedrock:claude-sonnet-5",
      folderId: "projects",
    });

    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "b" }),
    });
    expect(res.status).toBe(201);
    const rec = (await res.json()) as {
      threadId: string;
      source: string;
      parentThreadId: string;
      parentCheckpointId: string;
      title: string;
      modelId: string;
      folderId: string;
    };
    expect(rec.source).toBe("fork");
    expect(rec.parentThreadId).toBe("src");
    expect(rec.parentCheckpointId).toBe("chk_src");
    expect(rec.title).toBe("Order (fork)");
    expect(rec.modelId).toBe("bedrock:claude-sonnet-5");
    expect(rec.folderId).toBe("projects");

    const upd = getUpdated()!;
    expect(upd.threadId).toBe(rec.threadId);
    expect((upd.values as { messages: ForkMessage[] }).messages.map((m) => m.id)).toEqual(["a", "b"]);

    const hits = host.search.search("pizza");
    expect(hits.some((h) => h.threadId === rec.threadId)).toBe(true);
  });

  it("400s without messageId or messageIndex", async () => {
    const { host } = fakeHost([human("a")]);
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("resolves messageIndex when no messageId is given", async () => {
    const history = [human("a"), ai("b"), human("c")];
    const { host, getUpdated } = fakeHost(history);
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIndex: 1 }),
    });
    expect(res.status).toBe(201);
    expect((getUpdated()!.values as { messages: ForkMessage[] }).messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("404s when the source thread has no history", async () => {
    const { host } = fakeHost([]);
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "b" }),
    });
    expect(res.status).toBe(404);
  });

  it("409s forking a thread with an active run", async () => {
    const { host } = fakeHost([human("a"), ai("b")], new Set(["src"]));
    host.threadStore.create({ threadId: "src", title: "Order" });
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "b" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "cannot fork a thread while a run is active",
    });
  });

  it("400s forking at a user message (B2 boundary)", async () => {
    const { host } = fakeHost([human("a"), ai("b")]);
    host.threadStore.create({ threadId: "src", title: "Order" });
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "a" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "can only fork at a completed assistant turn",
    });
  });

  it("400s forking mid-tool-call (B2 boundary)", async () => {
    const { host } = fakeHost([human("a"), ai("b", ["c1"])]);
    host.threadStore.create({ threadId: "src", title: "Order" });
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "b" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "cannot fork mid-tool-call (unresolved tool_calls)",
    });
  });

  it("forks at a completed assistant turn that used tools (all resolved)", async () => {
    const history = [human("a", "research"), ai("b", ["c1"]), tool("t1", "c1"), ai("d")];
    const { host, getUpdated } = fakeHost(history);
    host.threadStore.create({ threadId: "src", title: "Order" });
    const res = await threadRoutes(host).request("/threads/src/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "d" }),
    });
    expect(res.status).toBe(201);
    expect((getUpdated()!.values as { messages: ForkMessage[] }).messages.map((m) => m.id)).toEqual([
      "a",
      "b",
      "t1",
      "d",
    ]);
  });

});

describe("threadRoutes: list + search", () => {
  it("lists threads and searches indexed messages", async () => {
    const { host } = fakeHost([]);
    host.threadStore.create({ threadId: "t1", title: "First" });
    host.search.reindexThread("t1", [{ getType: () => "human", content: "anchovy pizza", id: "m1" } as never]);

    const listRes = await threadRoutes(host).request("/threads/list");
    expect(await listRes.json()).toEqual([
      expect.objectContaining({ threadId: "t1", awaitingAction: false }),
    ]);

    const searchRes = await threadRoutes(host).request("/threads/search?q=anchovy");
    const hits = (await searchRes.json()) as Array<{
      threadId: string;
      snippet: string;
      highlights: Array<{ text: string; highlighted: boolean }>;
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("anchovy");
    expect(hits[0]!.highlights).toContainEqual({ text: "anchovy", highlighted: true });
  });

  it("search with a blank q returns []", async () => {
    const { host } = fakeHost([]);
    const res = await threadRoutes(host).request("/threads/search");
    expect(await res.json()).toEqual([]);
  });

  it("clamps search limits to the inclusive range from 1 through 200", async () => {
    const { host } = fakeHost([]);
    host.threadStore.create({ threadId: "search-limit", title: "Search limit" });
    host.search.reindexThread(
      "search-limit",
      Array.from({ length: 201 }, (_, i) => ({
        getType: () => "human",
        content: "anchovy",
        id: `message-${i}`,
      })),
    );

    const negative = await threadRoutes(host).request("/threads/search?q=anchovy&limit=-1");
    expect(await negative.json()).toHaveLength(1);

    const zero = await threadRoutes(host).request("/threads/search?q=anchovy&limit=0");
    expect(await zero.json()).toHaveLength(1);

    const capped = await threadRoutes(host).request("/threads/search?q=anchovy&limit=99999");
    expect(await capped.json()).toHaveLength(200);
  });
});

describe("threadRoutes: events", () => {
  it("streams a ready event followed by metadata changes", async () => {
    const { host, threadStore } = fakeHost([]);
    const abort = new AbortController();
    const res = await threadRoutes(host).request("/threads/events", {
      signal: abort.signal,
    });
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const ready = await reader.read();
    expect(decoder.decode(ready.value)).toContain("event: ready");

    threadStore.create({ threadId: "t1" });
    const changed = await reader.read();
    expect(decoder.decode(changed.value)).toContain("event: changed");

    abort.abort();
    await reader.cancel();
  });

  it("baselines existing activity and streams only later terminal runs", async () => {
    const { host, threadActivity } = fakeHost([]);
    const old = threadActivity.append({
      eventId: "run-old",
      threadId: "t1",
      runId: "run-old",
      outcome: "success",
      threadTitle: "Old",
    }).event;
    const abort = new AbortController();
    const res = await threadRoutes(host).request("/threads/activity/events", {
      signal: abort.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const ready = decoder.decode((await reader.read()).value);
    expect(ready).toContain("event: ready");
    expect(ready).toContain(`"cursor":${old.seq}`);

    threadActivity.append({
      eventId: "run-new",
      threadId: "t2",
      runId: "run-new",
      outcome: "interrupted",
      interruptIds: ["approval-1"],
      threadTitle: "New",
    });
    const activity = decoder.decode((await reader.read()).value);
    expect(activity).toContain("event: activity");
    expect(activity).toContain("run-new");
    expect(activity).not.toContain("run-old");

    abort.abort();
    await reader.cancel();
  });

  it("replays activity strictly after the requested cursor", async () => {
    const { host, threadActivity } = fakeHost([]);
    const first = threadActivity.append({
      eventId: "run-1",
      threadId: "t1",
      runId: "run-1",
      outcome: "success",
      threadTitle: "First",
    }).event;
    threadActivity.append({
      eventId: "run-2",
      threadId: "t2",
      runId: "run-2",
      outcome: "success",
      threadTitle: "Second",
    });
    const abort = new AbortController();
    const res = await threadRoutes(host).request(
      `/threads/activity/events?since=${first.seq}`,
      { signal: abort.signal },
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
    const replay = decoder.decode((await reader.read()).value);
    expect(replay).toContain("run-2");
    expect(replay).not.toContain("run-1");

    abort.abort();
    await reader.cancel();
  });
});

describe("threadRoutes: patch (pin / rename)", () => {
  it("toggles pinned and returns the updated record", async () => {
    const { host } = fakeHost([]);
    host.threadStore.create({ threadId: "t1", title: "First" });

    const res = await threadRoutes(host).request("/threads/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(200);
    const rec = (await res.json()) as { threadId: string; pinned: boolean };
    expect(rec).toMatchObject({ threadId: "t1", pinned: true });
    expect(host.threadStore.get("t1")?.pinned).toBe(true);
  });

  it("404s when patching a thread that doesn't exist", async () => {
    const { host } = fakeHost([]);
    const res = await threadRoutes(host).request("/threads/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(404);
  });

  it("clears the unread flag (the web's mark-read on open)", async () => {
    const { host } = fakeHost([]);
    host.threadStore.create({ threadId: "t1", title: "First" });
    host.threadStore.update("t1", { unread: true });

    const res = await threadRoutes(host).request("/threads/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unread: false }),
    });
    expect(res.status).toBe(200);
    const rec = (await res.json()) as { threadId: string; unread: boolean };
    expect(rec).toMatchObject({ threadId: "t1", unread: false });
    expect(host.threadStore.get("t1")?.unread).toBe(false);
  });

  it("moves a thread into a folder and back to unfiled", async () => {
    const { host } = fakeHost([]);
    host.folderStore.create({ folderId: "projects", name: "Projects" });
    host.threadStore.create({ threadId: "t1" });

    const moved = await threadRoutes(host).request("/threads/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId: "projects" }),
    });
    expect((await moved.json()) as { folderId?: string }).toMatchObject({
      folderId: "projects",
    });

    const cleared = await threadRoutes(host).request("/threads/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId: null }),
    });
    expect((await cleared.json()) as { folderId?: string }).not.toHaveProperty(
      "folderId",
    );
  });

  it("rejects moves into unknown folders", async () => {
    const { host } = fakeHost([]);
    host.threadStore.create({ threadId: "t1" });
    const response = await threadRoutes(host).request("/threads/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId: "missing" }),
    });
    expect(response.status).toBe(404);
    expect(host.threadStore.get("t1")?.folderId).toBeUndefined();
  });
});

describe("threadRoutes: delete", () => {
  it("deletes the thread row, purges its FTS rows, and purges its checkpoint history", async () => {
    const { host, purgedCheckpoints } = fakeHost([]);
    host.threadStore.create({ threadId: "t1", title: "First" });
    host.search.reindexThread("t1", [
      { getType: () => "human", content: "anchovy pizza", id: "m1" } as never,
    ]);
    expect(host.search.search("anchovy")).toHaveLength(1);

    const res = await threadRoutes(host).request("/threads/t1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(host.threadStore.get("t1")).toBeUndefined();
    expect(host.search.search("anchovy")).toHaveLength(0);
    expect(purgedCheckpoints).toEqual(["t1"]);
  });

  it("reports deleted:false for an unknown thread but still purges any orphan checkpoints", async () => {
    const { host, purgedCheckpoints } = fakeHost([]);
    const res = await threadRoutes(host).request("/threads/missing", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false });
    expect(purgedCheckpoints).toEqual(["missing"]);
  });
});
