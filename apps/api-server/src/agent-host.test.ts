import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ProtocolEvent } from "@langchain/langgraph";
import {
  PIZZA_BOT_AGENT,
  type RunInput,
  type RunOptions,
  type ThreadState,
} from "@pizza-bot/core";
import { pluginManifestSchema } from "@pizza-bot/plugin-api";
import { AgentHost } from "./agent-host.js";
import type { ImportedPlugin } from "./plugin-import.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function materializerPlugin(
  name: string,
  script: string,
): ImportedPlugin {
  const manifest = pluginManifestSchema.parse({
    name,
    extensions: {
      "dev.pizzabot.materializer": {
        entrypoint: "./materialize.mjs",
        sourceRoots: [],
      },
    },
  });
  const encode = (value: string) => new TextEncoder().encode(value);
  return {
    name,
    manifest,
    files: [
      {
        path: ".claude-plugin/plugin.json",
        content: encode(`${JSON.stringify(manifest)}\n`),
      },
      { path: "materialize.mjs", content: encode(script) },
    ],
  };
}

describe("AgentHost lifecycle and identity", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "identity-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "identity-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
  });

  afterEach(async () => {
    await host.close();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  it("exposes Pizza Bot as the runtime identity", () => {
    expect(PIZZA_BOT_AGENT.id).toBe("pizza-bot");
  });

  it("reconnects MCP before recovering schedules after system sleep", async () => {
    const order: string[] = [];
    const reload = vi
      .spyOn(host, "reloadMcpServers")
      .mockImplementation(async () => {
        order.push("mcp");
      });
    const recover = vi
      .spyOn(host.triggerService, "recoverAfterSystemSleep")
      .mockImplementation(() => {
        order.push("schedules");
        return true;
      });

    await host.resumeFromSystemSleep();

    expect(order).toEqual(["mcp", "schedules"]);
    reload.mockRestore();
    recover.mockRestore();
  });

  it("keeps user skills under the data root", async () => {
    expect(await host.skillsDirectory()).toBe(join(dataRoot, "skills"));
  });

  it("rejects unsafe plugin management names", async () => {
    const outsideName = `${basename(dataRoot)}-outside`;
    const outside = join(dataRoot, "..", outsideName);
    mkdirSync(join(outside, ".claude-plugin"), { recursive: true });
    try {
      expect(await host.pluginIsInstalled(`../../${outsideName}`)).toBe(false);
      await expect(
        host.deletePlugin(`../../${outsideName}`),
      ).resolves.toBe(false);
      expect(existsSync(join(outside, ".claude-plugin"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("loads and removes a user skill", async () => {
    const skillDir = join(dataRoot, "skills", "researcher");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: researcher\ndescription: Customized research.\n---\n",
    );

    await host.reloadSkills();
    expect(await host.skillFor("researcher")).toMatchObject({
      source: "user",
    });
    expect(await host.skillCatalog()).toContainEqual(
      expect.objectContaining({
        id: "researcher",
        source: "user",
      }),
    );

    rmSync(skillDir, { recursive: true });
    await host.reloadSkills();
    expect(await host.skillFor("researcher")).toBeUndefined();
  });

  it("rolls back a plugin whose first materialization fails", async () => {
    await expect(
      host.installPlugin(
        materializerPlugin(
          "broken-materializer",
          'throw new Error("cannot translate source");\n',
        ),
      ),
    ).rejects.toThrow(/cannot translate source/);

    expect(await host.pluginIsInstalled("broken-materializer")).toBe(false);
    expect(
      existsSync(
        join(dataRoot, "plugin-materializations", "broken-materializer"),
      ),
    ).toBe(false);
  });

  it("removes a materialized plugin and its generated cache", async () => {
    await host.installPlugin(
      materializerPlugin(
        "generated-plugin",
        `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const output = process.env.PIZZA_MATERIALIZER_OUTPUT_DIR;
mkdirSync(join(output, ".claude-plugin"), { recursive: true });
writeFileSync(
  join(output, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: process.env.PIZZA_MATERIALIZER_PLUGIN_NAME }),
);
`,
      ),
    );

    expect(await host.pluginIsInstalled("generated-plugin")).toBe(true);
    expect(
      existsSync(join(dataRoot, "plugin-materializations", "generated-plugin")),
    ).toBe(true);

    await expect(host.deletePlugin("generated-plugin")).resolves.toBe(true);
    expect(
      existsSync(join(dataRoot, "plugin-materializations", "generated-plugin")),
    ).toBe(false);
  });

  it("rebuilds workers when only a skill's instructions change", async () => {
    const skillDir = join(dataRoot, "skills", "plain");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: plain\ndescription: Plain specialist.\n---\n\nFirst instructions.\n",
    );
    await host.reloadSkills();
    const first = host.agent;

    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: plain\ndescription: Plain specialist.\n---\n\nUpdated instructions.\n",
    );
    await host.reloadSkills();

    expect(host.agent).not.toBe(first);
  });

  it("falls through automatic candidates until one builds", async () => {
    const buildAutomaticModel = (
      host as unknown as {
        buildAutomaticModel(
          ids: string[],
          build: (id: string) => Promise<unknown>,
        ): Promise<{ modelId: string; model: unknown }>;
      }
    ).buildAutomaticModel.bind(host);
    const built: string[] = [];

    const selected = await buildAutomaticModel(
      ["bedrock:sonnet-5", "google:gemini-pro"],
      async (modelId) => {
        built.push(modelId);
        if (modelId === "bedrock:sonnet-5") throw new Error("not entitled");
        return { modelId };
      },
    );

    expect(built).toEqual(["bedrock:sonnet-5", "google:gemini-pro"]);
    expect(selected).toMatchObject({
      modelId: "google:gemini-pro",
      model: { modelId: "google:gemini-pro" },
    });
  });

  it("pins the resolved model to a thread and reuses it on later turns", async () => {
    const agentFor = vi.spyOn(host, "agentFor").mockResolvedValue(host.agent);
    const resolveTurn = (
      host as unknown as {
        resolveTurn(opts: RunOptions): Promise<unknown>;
      }
    ).resolveTurn.bind(host);

    await resolveTurn({
      threadId: "model-thread",
      configurable: { model: "bedrock:claude-sonnet-5" },
    });
    await resolveTurn({ threadId: "model-thread" });

    expect(host.threadStore.get("model-thread")?.modelId).toBe(
      "bedrock:claude-sonnet-5",
    );
    expect(agentFor).toHaveBeenNthCalledWith(1, "bedrock:claude-sonnet-5");
    expect(agentFor).toHaveBeenNthCalledWith(2, "bedrock:claude-sonnet-5");
  });

  it("persists interrupted threads without running completion maintenance", async () => {
    const maintenance = (
      host as unknown as {
        runMaintenance: {
          reindexThread(threadId: string): Promise<void>;
          onRunEnd(threadId: string): Promise<void>;
        };
      }
    ).runMaintenance;
    const reindex = vi.spyOn(maintenance, "reindexThread").mockImplementation(async (threadId) => {
      host.threadStore.ensure({ threadId });
      host.threadStore.update(threadId, {
        lastMessage: "Approve the quarterly report",
        lastMessageRole: "human",
      });
    });
    const complete = vi.spyOn(maintenance, "onRunEnd");
    (
      host as unknown as {
        streamProtocolReady(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent>;
      }
    ).streamProtocolReady = async function* () {
      yield {
        type: "event",
        seq: 0,
        method: "lifecycle",
        params: {
          namespace: [],
          timestamp: 0,
          data: { event: "interrupted", graph_name: "root" },
        },
      } as ProtocolEvent;
    };

    host.protocolRuns.start("paused-thread", { messages: [] });

    await vi.waitFor(() => {
      expect(host.threadStore.get("paused-thread")).toMatchObject({
        unread: true,
        awaitingAction: true,
      });
    });
    expect(reindex).toHaveBeenCalledWith("paused-thread");
    expect(complete).not.toHaveBeenCalled();
    expect(host.threadActivity.listAfter(0)).toEqual([
      expect.objectContaining({
        threadId: "paused-thread",
        outcome: "interrupted",
        threadTitle: "Approve the quarterly report",
      }),
    ]);
  });

  it("keeps a thread in the Action filter when a run is cancelled while paused", async () => {
    const maintenance = (
      host as unknown as { runMaintenance: { onRunEnd(threadId: string): Promise<void> } }
    ).runMaintenance;
    vi.spyOn(maintenance, "onRunEnd").mockImplementation(async (threadId) => {
      host.threadStore.ensure({ threadId });
    });
    vi.spyOn(host.agent, "getState").mockResolvedValue({
      threadId: "cancelled-while-paused",
      checkpointId: "checkpoint-1",
      values: { messages: [] },
      next: [],
      createdAt: "2026-08-09T00:00:00.000Z",
      awaitingInput: true,
      interrupts: [{ id: "approval-1", value: { action: "send" } }],
      tasks: [],
    } satisfies ThreadState);

    const started = deferred();
    (
      host as unknown as {
        streamProtocolReady(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent>;
      }
    ).streamProtocolReady = (_input, opts) => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          started.resolve();
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve());
          });
          return { done: true, value: undefined };
        },
      }),
    });

    const { runId } = host.protocolRuns.start("cancelled-while-paused", { messages: [] });
    await started.promise;
    await host.protocolRuns.cancelAndWait("cancelled-while-paused", runId);

    await vi.waitFor(() => {
      expect(host.threadStore.get("cancelled-while-paused")).toMatchObject({
        awaitingAction: true,
      });
    });
  });

  it("does not let delayed interrupt maintenance restore action state after a response", async () => {
    const maintenance = (
      host as unknown as {
        runMaintenance: {
          reindexThread(threadId: string): Promise<void>;
        };
      }
    ).runMaintenance;
    const reindexStarted = deferred();
    const releaseReindex = deferred();
    vi.spyOn(maintenance, "reindexThread").mockImplementation(async (threadId) => {
      reindexStarted.resolve();
      await releaseReindex.promise;
      host.threadStore.ensure({ threadId });
    });
    (
      host as unknown as {
        streamProtocolReady(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent>;
      }
    ).streamProtocolReady = async function* () {
      yield {
        type: "event",
        seq: 0,
        method: "lifecycle",
        params: {
          namespace: [],
          timestamp: 0,
          data: { event: "interrupted", graph_name: "root" },
        },
      } as ProtocolEvent;
    };

    host.protocolRuns.start("paused-thread", { messages: [] });
    await reindexStarted.promise;
    const clearing = host.clearThreadAwaitingAction("paused-thread");

    releaseReindex.resolve();
    await clearing;

    expect(host.threadStore.get("paused-thread")).toMatchObject({
      awaitingAction: false,
    });
  });

  it("restores Action from the durable checkpoint after a failed response", async () => {
    host.threadStore.create({ threadId: "failed-response" });
    host.threadStore.update("failed-response", { awaitingAction: true });
    await host.clearThreadAwaitingAction("failed-response");
    vi.spyOn(host.agent, "getState").mockResolvedValue({
      threadId: "failed-response",
      checkpointId: "checkpoint-1",
      values: { messages: [] },
      next: [],
      createdAt: "2026-08-09T00:00:00.000Z",
      awaitingInput: true,
      interrupts: [{ id: "approval-1", value: { action: "send" } }],
      tasks: [],
    } satisfies ThreadState);
    (
      host as unknown as {
        streamProtocolReady(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent>;
      }
    ).streamProtocolReady = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("resume failed")),
      }),
    });

    host.protocolRuns.start("failed-response", { command: {} as never });

    await vi.waitFor(() => {
      expect(host.threadStore.get("failed-response")).toMatchObject({
        unread: true,
        awaitingAction: true,
      });
    });
    expect(host.threadActivity.listAfter(0)).toEqual([
      expect.objectContaining({
        threadId: "failed-response",
        outcome: "error",
      }),
    ]);
  });

  it("conservatively restores Action when failed-response state cannot be read", async () => {
    host.threadStore.create({ threadId: "unreadable-response" });
    host.threadStore.update("unreadable-response", { awaitingAction: true });
    await host.clearThreadAwaitingAction("unreadable-response");
    vi.spyOn(host.agent, "getState").mockRejectedValue(new Error("checkpoint unavailable"));
    (
      host as unknown as {
        streamProtocolReady(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent>;
      }
    ).streamProtocolReady = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("resume failed")),
      }),
    });

    host.protocolRuns.start("unreadable-response", { command: {} as never });

    await vi.waitFor(() => {
      expect(host.threadStore.get("unreadable-response")).toMatchObject({
        unread: true,
        awaitingAction: true,
      });
    });
  });
});

describe("AgentHost.deleteThread", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "delete-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "delete-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
  });

  afterEach(async () => {
    await host.close();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  it("removes the thread record and its search index, reporting deleted:true", async () => {
    host.threadStore.create({ threadId: "t1", title: "Order" });
    host.search.reindexThread("t1", [
      { getType: () => "human", content: "anchovy pizza", id: "m1" } as never,
    ]);
    host.threadActivity.append({
      eventId: "t1:run-1",
      threadId: "t1",
      runId: "run-1",
      outcome: "success",
      threadTitle: "Order",
    });
    expect(host.search.search("anchovy")).toHaveLength(1);
    expect(host.threadActivity.listAfter(0)).toHaveLength(1);

    await expect(host.deleteThread("t1")).resolves.toBe(true);
    expect(host.threadStore.get("t1")).toBeUndefined();
    expect(host.search.search("anchovy")).toHaveLength(0);
    expect(host.threadActivity.listAfter(0)).toHaveLength(0);
  });

  it("reports deleted:false before the checkpoint schema has been initialized", async () => {
    await expect(host.deleteThread("missing")).resolves.toBe(false);
  });

  it("shares one cleanup operation between concurrent deletes", async () => {
    host.threadStore.create({ threadId: "t1", title: "Order" });
    const first = host.deleteThread("t1");
    const second = host.deleteThread("t1");
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("keeps the run fence held across a partial failure and reuses it on retry", async () => {
    host.threadStore.create({ threadId: "t1", title: "Order" });
    let beginCount = 0;
    let releaseCount = 0;
    const realBegin = host.protocolRuns.beginThreadDeletion.bind(host.protocolRuns);
    host.protocolRuns.beginThreadDeletion = async (threadId: string) => {
      beginCount += 1;
      const release = await realBegin(threadId);
      return () => {
        releaseCount += 1;
        release();
      };
    };
    const realSearchDelete = host.search.deleteThread.bind(host.search);
    let attempts = 0;
    host.search.deleteThread = (threadId: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("search failed");
      return realSearchDelete(threadId);
    };

    await expect(host.deleteThread("t1")).rejects.toThrow("search failed");
    // Retry completes cleanup (record already gone from the first partial pass).
    await expect(host.deleteThread("t1")).resolves.toBe(false);
    // One fence acquired for the whole operation, released only after success.
    expect(beginCount).toBe(1);
    expect(releaseCount).toBe(1);
  });
});
