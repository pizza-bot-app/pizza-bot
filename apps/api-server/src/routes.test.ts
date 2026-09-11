import { describe, it, expect, vi } from "vitest";
import { delimiter as pathDelimiter } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import { PROTOCOL_VERSION } from "@pizza-bot/core";
import {
  buildApp,
  parseLocalFolderBrowseRoots,
  resolveServerNetworkConfig,
} from "./index.js";
import type { AgentHost } from "./agent-host.js";

function fakeHost(
  readiness: "warming" | "ready" | "failed" = "ready",
  historyCalls?: Array<string | undefined>,
  runStarts?: Array<{ threadId: string; configurable?: Record<string, unknown> }>,
  historyTasks?: Array<{
    id: string;
    name: string;
    path?: unknown[];
    result?: unknown;
    interrupts: Array<{ id: string; value: unknown }>;
  }>,
): AgentHost {
  const host = {
    dataRoot: ":memory:",
    modelId: "fake:model",
    readiness,
    whenReady: async () => {},
    skillsDirectory: async () => null,
    listMcpServers: async () => [],
    listProviders: async () => [
      { id: "bedrock", availableWithoutConfig: false },
      { id: "anthropic", availableWithoutConfig: false },
      { id: "ollama", availableWithoutConfig: true },
    ],
    listModelCatalog: async () => ({
      models: [
        { id: "bedrock:sonnet", displayName: "Sonnet", provider: "bedrock" },
        { id: "ollama:qwen", displayName: "Qwen", provider: "ollama" },
        { id: "ollama:llama", displayName: "Llama", provider: "ollama" },
      ],
      providers: [
        { provider: "bedrock", status: "ready", modelCount: 1, stale: false },
        { provider: "anthropic", status: "error", modelCount: 0, stale: false },
        { provider: "ollama", status: "ready", modelCount: 2, stale: false },
      ],
    }),
    mcpHealthSnapshot: () => ({}),
    providerConfigs: { getConfig: () => undefined },
    contextWindow: async () => undefined,
    agent: {
      async getState(threadId: string) {
        return {
          threadId,
          checkpointId: "chk1",
          values: { messages: [] },
          next: [],
          createdAt: "t0",
          interrupts: [{ id: "approval-1", value: { action: "send" } }],
        };
      },
      async *getStateHistory(threadId: string, checkpointNs?: string) {
        historyCalls?.push(checkpointNs);
        yield {
          threadId,
          checkpointId: "chk2",
          checkpointNs: checkpointNs ?? "",
          values: {},
          next: [],
          createdAt: "t1",
          tasks: historyTasks,
          interrupts: [{ id: "approval-2", value: { action: "delete" } }],
        };
        yield { threadId, checkpointId: "chk1", values: {}, next: [], createdAt: "t0" };
      },
      async updateState(threadId: string) {
        return { checkpointId: "chk2", threadId };
      },
    },
    threadStore: {
      update: (threadId: string) => ({
        threadId,
        title: "t",
        source: "user",
        pinned: false,
        createdAt: "t0",
        lastActivityAt: "t0",
      }),
      delete: () => true,
    },
    search: { deleteThread: () => {} },
    triggers: {
      get: () => undefined,
    },
    persistence: {
      checkpointer: {
        deleteThread: async () => {},
      },
    },
    deleteThread: async () => true,
    protocolRuns: {
      start: (
        threadId: string,
        _input: unknown,
        opts?: { configurable?: Record<string, unknown> },
      ) => {
        runStarts?.push({
          threadId,
          ...(opts?.configurable ? { configurable: opts.configurable } : {}),
        });
        return { runId: "run-1", threadId };
      },
      cancel: () => false,
      cancelAndWait: async () => ({ accepted: false, settled: false }),
      async *observe() {},
    },
  } as unknown as AgentHost;
  return host;
}

describe("api-server: health probe", () => {
  it("GET /ping returns Healthy", async () => {
    const res = await buildApp(fakeHost()).request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "Healthy" });
  });

  it("GET /ping reports warming without failing the supervisor probe", async () => {
    const res = await buildApp(fakeHost("warming")).request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "HealthyBusy" });
  });

  it("GET /ping fails after warmup rejects", async () => {
    const res = await buildApp(fakeHost("failed")).request("/ping");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "Unhealthy" });
  });

  it("GET / advertises the wire protocol version", async () => {
    const res = await buildApp(fakeHost()).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      service: "pizza-bot",
      protocolVersion: PROTOCOL_VERSION,
      apiVersion: String(PROTOCOL_VERSION),
    });
  });

  it("GET /status publishes the server timezone used by default schedules", async () => {
    const res = await buildApp(fakeHost()).request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      inference: {
        available: true,
        connected: 1,
        total: 3,
        providers: [
          { name: "bedrock", status: "unavailable", modelCount: 1 },
          { name: "anthropic", status: "unavailable", modelCount: 0 },
          { name: "ollama", status: "connected", modelCount: 2 },
        ],
      },
    });
  });
});

describe("api-server: JSON request limits", () => {
  it("accepts skill create/update bundles containing a 900 KiB binary sibling", async () => {
    const png = Buffer.alloc(900 * 1024).toString("base64");
    const payload = JSON.stringify({
      id: "image-skill",
      name: "Image skill",
      description: "Uses a reference image.",
      body: "# Image skill",
      files: [{
        path: "assets/reference.png",
        content: png,
        encoding: "base64",
        mimeType: "image/png",
      }],
    });

    for (const [method, path] of [
      ["POST", "/skills"],
      ["PATCH", "/skills/image-skill"],
    ] as const) {
      const res = await buildApp(fakeHost()).request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "skills_disabled" });
    }
  });

  it("keeps the ordinary limit on other skill JSON routes", async () => {
    const res = await buildApp(fakeHost()).request("/skills/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(1024 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "request_too_large" });
  });
});

describe("api-server: network safety", () => {
  it("defaults to loopback with a fixed local origin allowlist", () => {
    expect(resolveServerNetworkConfig({})).toEqual({
      hostname: "127.0.0.1",
      allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    });
  });

  it("refuses remote binding without both authentication and explicit origins", () => {
    expect(() => resolveServerNetworkConfig({ PIZZA_HOST: "0.0.0.0" })).toThrow("PIZZA_API_TOKEN");
    expect(() =>
      resolveServerNetworkConfig({
        PIZZA_HOST: "0.0.0.0",
        PIZZA_API_TOKEN: "a".repeat(32),
      }),
    ).toThrow("PIZZA_ALLOWED_ORIGINS");
    expect(() => resolveServerNetworkConfig({ PIZZA_HOST: "127.example.com" })).toThrow(
      "PIZZA_API_TOKEN",
    );
  });

  it("refuses a short token for non-loopback binding", () => {
    expect(() =>
      resolveServerNetworkConfig({
        PIZZA_HOST: "0.0.0.0",
        PIZZA_API_TOKEN: "secret",
        PIZZA_ALLOWED_ORIGINS: "https://pizza.example",
      }),
    ).toThrow("shorter than 32 characters");
  });

  it("allows an authenticated, origin-restricted remote configuration", () => {
    const apiToken = "a".repeat(32);
    expect(
      resolveServerNetworkConfig({
        PIZZA_HOST: "0.0.0.0",
        PIZZA_API_TOKEN: apiToken,
        PIZZA_ALLOWED_ORIGINS: "https://pizza.example, https://admin.example",
      }),
    ).toEqual({
      hostname: "0.0.0.0",
      apiToken,
      allowedOrigins: ["https://pizza.example", "https://admin.example"],
    });
  });

  it("enables local-folder configuration only when explicitly requested", () => {
    expect(
      resolveServerNetworkConfig({
        PIZZA_ALLOW_LOCAL_FOLDER_CONFIGURATION: "1",
      }),
    ).toMatchObject({ allowLocalFolderConfiguration: true });
    expect(
      resolveServerNetworkConfig({
        PIZZA_ALLOW_LOCAL_FOLDER_CONFIGURATION: "true",
      }),
    ).not.toHaveProperty("allowLocalFolderConfiguration");
  });

  it("parses backend browse roots with the host path delimiter", () => {
    expect(parseLocalFolderBrowseRoots("/srv/projects:/mnt/shared", ":")).toEqual([
      "/srv/projects",
      "/mnt/shared",
    ]);
    expect(
      parseLocalFolderBrowseRoots("C:\\Users\\builder;D:\\Shared", ";"),
    ).toEqual(["C:\\Users\\builder", "D:\\Shared"]);
    expect(
      resolveServerNetworkConfig({
        PIZZA_LOCAL_FOLDER_BROWSE_ROOTS:
          ["/srv/projects", "/mnt/shared"].join(pathDelimiter),
      }),
    ).toMatchObject({
      localFolderBrowseRoots: ["/srv/projects", "/mnt/shared"],
    });
  });

  it("actively rejects arbitrary origins", async () => {
    const app = buildApp(fakeHost(), { allowedOrigins: ["https://pizza.example"] });
    const denied = await app.request("/", { headers: { origin: "https://evil.example" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const allowed = await app.request("/", { headers: { origin: "https://pizza.example" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://pizza.example");
  });

  it("blocks a simple evil-origin POST before it can start a run", async () => {
    const starts: Array<{ threadId: string }> = [];
    const app = buildApp(fakeHost("ready", undefined, starts), {
      allowedOrigins: ["https://pizza.example"],
    });
    const res = await app.request("/threads/victim/commands", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ id: 1, method: "run.start", params: { input: "attack" } }),
    });

    expect(res.status).toBe(403);
    expect(starts).toEqual([]);
  });

  it("allows missing Origin and explicitly configured Origin: null", async () => {
    const app = buildApp(fakeHost(), { allowedOrigins: ["null"] });
    expect((await app.request("/ping")).status).toBe(200);
    expect((await app.request("/ping", { headers: { origin: "null" } })).status).toBe(200);
    expect(
      (await app.request("/ping", { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
  });

  it("permits bearer-authenticated preflights only from allowed origins", async () => {
    const app = buildApp(fakeHost(), {
      apiToken: "secret",
      allowedOrigins: ["https://pizza.example"],
    });
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: {
        origin: "https://pizza.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://pizza.example");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
  });

  it("requires the configured bearer token except for health checks", async () => {
    const app = buildApp(fakeHost(), { apiToken: "correct horse" });
    expect((await app.request("/ping")).status).toBe(200);
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/", { headers: { authorization: "Bearer wrong" } })).status).toBe(
      401,
    );
    expect(
      (await app.request("/", { headers: { authorization: "Bearer correct horse" } })).status,
    ).toBe(200);
  });

  it("leaves per-trigger-authenticated webhook invocation outside global auth", async () => {
    const app = buildApp(fakeHost(), { apiToken: "global-secret" });
    const res = await app.request("/triggers/missing/invoke", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("api-server: checkpoint-shaped state surface", () => {
  it("POST /threads mints a thread id", async () => {
    const res = await buildApp(fakeHost()).request("/threads", { method: "POST", body: "{}" });
    const body = (await res.json()) as { thread_id: string; status: string };
    expect(body.thread_id).toMatch(/^thread_/);
    expect(body.status).toBe("idle");
  });

  it("GET /threads/:id/state returns snake_case state", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/state");
    expect(await res.json()).toMatchObject({ thread_id: "t1", checkpoint_id: "chk1", next: [] });
  });

  it("preserves HITL interrupts in live and historical state", async () => {
    const app = buildApp(fakeHost());
    const live = (await (await app.request("/threads/t1/state")).json()) as {
      tasks: Array<{ interrupts: Array<{ id: string }> }>;
    };
    const history = (await (await app.request("/threads/t1/history")).json()) as Array<{
      tasks?: Array<{ interrupts: Array<{ id: string }> }>;
    }>;

    expect(live.tasks[0]?.interrupts[0]?.id).toBe("approval-1");
    expect(history[0]?.tasks?.[0]?.interrupts[0]?.id).toBe("approval-2");
  });

  it("rejects a configurable thread ID that disagrees with the URL", async () => {
    const starts: Array<{ threadId: string; configurable?: Record<string, unknown> }> = [];
    const app = buildApp(fakeHost("ready", undefined, starts));
    const res = await app.request("/threads/url-thread/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 1,
        method: "run.start",
        params: {
          input: "hello",
          config: { configurable: { thread_id: "other-thread", model: "test:model" } },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "thread_id_mismatch" });
    expect(starts).toEqual([]);
  });

  it("uses the URL thread and strips a matching thread ID from run options", async () => {
    const starts: Array<{ threadId: string; configurable?: Record<string, unknown> }> = [];
    const app = buildApp(fakeHost("ready", undefined, starts));
    const res = await app.request("/threads/url-thread/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 1,
        method: "run.start",
        params: {
          input: "hello",
          config: { configurable: { thread_id: "url-thread", model: "test:model" } },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(starts).toEqual([
      { threadId: "url-thread", configurable: { model: "test:model" } },
    ]);
  });

  it("disables reverse-proxy buffering on protocol event streams", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/stream/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channels: ["lifecycle"] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("clears awaiting action after accepting an HITL response", async () => {
    const host = fakeHost();
    const clearThreadAwaitingAction = vi.fn(async () => {});
    host.clearThreadAwaitingAction = clearThreadAwaitingAction;
    const app = buildApp(host);

    const res = await app.request("/threads/t1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 1,
        method: "input.respond",
        params: { response: { interruptId: "approval-1", decisions: [] } },
      }),
    });

    expect(res.status).toBe(200);
    expect(clearThreadAwaitingAction).toHaveBeenCalledWith("t1");
  });

  it("refuses an unrecognized command method with 418 and an error envelope", async () => {
    const starts: Array<{ threadId: string }> = [];
    const app = buildApp(fakeHost("ready", undefined, starts));
    const res = await app.request("/threads/t1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 7, method: "pizza.order", params: { toppings: ["pineapple"] } }),
    });

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({
      type: "error",
      id: 7,
      error: "unsupported_method",
      message: 'unsupported command method "pizza.order"',
    });
    expect(starts).toEqual([]);
  });

  it("refuses a body that is not a command at all with 418", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });

    expect(res.status).toBe(418);
    expect(await res.json()).toMatchObject({ type: "error", id: null, error: "unsupported_method" });
  });

  it("keeps the empty 204 for a run.stop with nothing to stop", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 8, method: "run.stop", params: {} }),
    });

    expect(res.status).toBe(204);
  });

  it("GET /threads/:id/history returns the checkpoint list (newest-first)", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/history");
    const list = (await res.json()) as Array<{ thread_id: string; checkpoint_id: string }>;
    expect(list.map((s) => s.checkpoint_id)).toEqual(["chk2", "chk1"]);
  });

  it("POST /threads/:id/history returns the checkpoint list", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 10 }),
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ checkpoint_id: string }>;
    expect(list.map((s) => s.checkpoint_id)).toEqual(["chk2", "chk1"]);
  });

  it("POST /threads/:id/history honors `limit`", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    const list = (await res.json()) as Array<{ checkpoint_id: string }>;
    expect(list.map((s) => s.checkpoint_id)).toEqual(["chk2"]);
  });

  it("POST /threads/:id/history forwards a scoped `checkpoint.checkpoint_ns`", async () => {
    const calls: Array<string | undefined> = [];
    const res = await buildApp(fakeHost("ready", calls)).request("/threads/t1/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1, checkpoint: { checkpoint_ns: "tools:sub-1" } }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["tools:sub-1"]);
  });

  it("preserves checkpoint and Pregel task metadata used for subagent hydration", async () => {
    const tasks = [{
      id: "worker-uuid",
      name: "tools",
      path: ["__pregel_push", 0],
      result: {
        messages: [new ToolMessage({
          tool_call_id: "task-call-1",
          content: "finished",
        })],
      },
      interrupts: [],
    }];
    const res = await buildApp(fakeHost("ready", undefined, undefined, tasks)).request(
      "/threads/t1/history",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      },
    );
    const [state] = (await res.json()) as Array<{
      checkpoint: { checkpoint_id: string; checkpoint_ns: string };
      tasks: typeof tasks;
    }>;

    expect(state?.checkpoint).toEqual({
      thread_id: "t1",
      checkpoint_ns: "",
      checkpoint_id: "chk2",
      checkpoint_map: null,
    });
    expect(state?.tasks).toEqual([{
      id: "worker-uuid",
      name: "tools",
      path: ["__pregel_push", 0],
      result: {
        messages: [{
          content: "finished",
          tool_call_id: "task-call-1",
          additional_kwargs: {},
          response_metadata: {},
          type: "tool",
        }],
      },
      interrupts: [],
      checkpoint: null,
    }]);
  });

  it("POST /threads/:id/history without a checkpoint scopes to the root thread", async () => {
    const calls: Array<string | undefined> = [];
    await buildApp(fakeHost("ready", calls)).request("/threads/t1/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });
    expect(calls).toEqual([undefined]);
  });

  it("POST /threads/:id/history `before` is an exclusive cursor", async () => {
    const res = await buildApp(fakeHost()).request("/threads/t1/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 10, before: { configurable: { checkpoint_id: "chk2" } } }),
    });
    const list = (await res.json()) as Array<{ checkpoint_id: string }>;
    expect(list.map((s) => s.checkpoint_id)).toEqual(["chk1"]);
  });

});
