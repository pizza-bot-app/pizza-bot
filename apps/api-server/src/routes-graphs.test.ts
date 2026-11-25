import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunInput, RunOptions } from "@pizza-bot/core";
import { openAppDatabase, type AppDatabase } from "@pizza-bot/storage";
import { graphRoutes } from "./routes-graphs.js";
import { GraphRegistry } from "./graph-registry.js";
import type { AgentHost } from "./agent-host.js";

const dirs: string[] = [];
const dbs: AppDatabase[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const spec = {
  name: "Digest",
  nodes: [{ id: "greet", type: "transform", set: { text: "hi {{input.who}}" } }],
  edges: [{ from: "start", to: "greet" }, { from: "greet", to: "end" }],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-graphs-"));
  dirs.push(dir);
  const db = openAppDatabase(":memory:");
  dbs.push(db);
  const starts: Array<{ threadId: string; input: RunInput; opts?: Partial<RunOptions> }> = [];
  const host = {
    graphRegistry: new GraphRegistry(path.join(dir, "graphs")),
    triggers: db.triggers,
    threadStore: db.threadStore,
    protocolRuns: {
      start(threadId: string, input: RunInput, opts?: Partial<RunOptions>) {
        starts.push({ threadId, input, ...(opts ? { opts } : {}) });
        return { runId: "run_1" };
      },
    },
  } as unknown as AgentHost;
  return { app: graphRoutes(host), host, starts, dir };
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("graph routes", () => {
  it("stores a valid spec under the URL id, lists it, and reports invalid files", async () => {
    const { app, dir } = setup();
    const saved = await app.request("/graphs/digest", put({ ...spec, id: "ignored" }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ id: "digest", name: "Digest" });
    fs.writeFileSync(path.join(dir, "graphs", "broken.json"), "{");

    const listing = (await (await app.request("/graphs")).json()) as {
      graphs: Array<{ id: string }>;
      invalid: Array<{ file: string }>;
    };
    expect(listing.graphs.map((g) => g.id)).toEqual(["digest"]);
    expect(listing.invalid.map((i) => i.file)).toEqual(["broken.json"]);
  });

  it("rejects invalid specs and ids that are not safe file names", async () => {
    const { app } = setup();
    const invalid = await app.request("/graphs/digest", put({ ...spec, edges: [] }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ detail: expect.arrayContaining(["no edge leaves start"]) });
    expect((await app.request("/graphs/..%2Fescape", put(spec))).status).toBe(400);
    expect((await app.request("/graphs/..%2Fescape")).status).toBe(404);
  });

  it("starts a manual run on a fresh thread and refuses to delete a graph a trigger or a run still uses", async () => {
    const { app, host, starts } = setup();
    await app.request("/graphs/digest", put(spec));
    const run = await app.request("/graphs/digest/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { who: "ada" } }),
    });
    expect(run.status).toBe(201);
    expect(starts[0]).toMatchObject({
      input: { graphInput: { who: "ada" } },
      opts: { configurable: { graph_id: "digest" } },
    });
    expect(starts[0]!.threadId).toMatch(/^thread_graph_/);

    host.triggers.create({ id: "t", kind: "cron", cron: "0 9 * * *", graphId: "digest", enabled: true });
    expect((await app.request("/graphs/digest", { method: "DELETE" })).status).toBe(409);
    host.triggers.delete("t");

    host.threadStore.create({ threadId: "thread_graph_1", graphId: "digest" });
    const stranded = await app.request("/graphs/digest", { method: "DELETE" });
    expect(stranded.status).toBe(409);
    expect(await stranded.json()).toMatchObject({ error: "in_use", detail: expect.stringContaining("1 run ") });
    expect(await (await app.request("/graphs/digest/runs")).json()).toMatchObject([{ threadId: "thread_graph_1" }]);
    host.threadStore.delete("thread_graph_1");

    expect((await app.request("/graphs/digest", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/graphs/digest")).status).toBe(404);
  });
});
