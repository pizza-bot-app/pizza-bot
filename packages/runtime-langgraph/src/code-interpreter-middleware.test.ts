import { afterEach, describe, expect, it } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createWorkerCodeInterpreterMiddleware } from "./code-interpreter-middleware.js";

const GUEST_DEADLINE_MS = 1_500;

interface WorkerMiddleware {
  tools: Array<{ invoke: (args: { code: string }, config: RunnableConfig) => Promise<string> }>;
  wrapModelCall: (
    request: { tools: unknown[]; systemMessage: SystemMessage },
    handler: (request: unknown) => unknown) => Promise<unknown>;
  afterAgent?: (state: unknown, runtime: unknown) => Promise<unknown>;
}

let middleware: WorkerMiddleware | null = null;

/** LangGraph's namespace shapes: `<invocation>|tools:<id>` and `<invocation>|<after_agent node>`. */
function toolCall(invocation: string): RunnableConfig {
  return {
    configurable: { thread_id: "sandbox-test", checkpoint_ns: `${invocation}|tools:call` },
  };
}
function afterAgentRuntime(invocation: string): unknown {
  return {
    configurable: {
      thread_id: "sandbox-test",
      checkpoint_ns: `${invocation}|CodeInterpreterMiddleware.after_agent:node`,
    },
  };
}

const config = toolCall("tools:root");

// Spawning a worker under the tsx loader takes seconds on Windows CI.
const WORKER_TEST_TIMEOUT_MS = 30_000;

async function sandbox(ptc: string[] = []): Promise<WorkerMiddleware> {
  middleware = (await createWorkerCodeInterpreterMiddleware({
    ptc,
    maxResultChars: 2_000,
    executionTimeoutMs: GUEST_DEADLINE_MS,
    subagents: false,
  })) as WorkerMiddleware;
  return middleware;
}

afterEach(async () => {
  await middleware?.afterAgent?.({}, afterAgentRuntime("tools:root"));
  await middleware?.afterAgent?.({}, afterAgentRuntime("tools:root|1"));
  middleware = null;
});

/** Counts event-loop turns: a blocked loop simply never fires the interval. */
function countTicks(): () => number {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  return () => {
    clearInterval(timer);
    return ticks;
  };
}

describe("worker-hosted code interpreter", () => {
  it("evaluates guest code and formats the result", async () => {
    const { tools } = await sandbox();
    const output = await tools[0]!.invoke({ code: "1 + 1" }, config);
    expect(output).toContain("2");
  });

  it("keeps the event loop responsive while guest code spins", async () => {
    const { tools } = await sandbox();
    const stop = countTicks();
    // Guest code that never awaits holds its thread until the deadline aborts it,
    // so this is only survivable because that thread is not the server's.
    await tools[0]!.invoke({ code: "let n = 0; while (true) n++;" }, config).catch(() => {});
    const ticks = stop();

    expect(ticks).toBeGreaterThan(20);
  }, 20_000);

  it("gives concurrent invocations of one agent separate sessions", async () => {
    // Parallel runs of one skill share this middleware instance and thread; only
    // the namespace tells them apart, and LangGraph suffixes the second one.
    const { tools, afterAgent } = await sandbox();
    const first = toolCall("tools:root");
    const second = toolCall("tools:root|1");
    await Promise.all([
      tools[0]!.invoke({ code: "globalThis.owner = 'first'" }, first),
      tools[0]!.invoke({ code: "globalThis.owner = 'second'" }, second),
    ]);
    await afterAgent?.({}, afterAgentRuntime("tools:root"));

    expect(await tools[0]!.invoke({ code: "owner" }, second)).toContain("second");
    expect(await tools[0]!.invoke({ code: "typeof owner" }, first)).toContain("undefined");
  }, WORKER_TEST_TIMEOUT_MS);

  it("runs each bridged call under the config of the eval that issued it", async () => {
    // One model turn can emit several evals into one invocation's session.
    const whoAsked = tool((_args, config) => String(config?.metadata?.caller), {
      name: "who_asked",
      description: "Reports which eval's config the call ran under.",
      schema: z.object({}),
    });
    const sandboxMiddleware = await sandbox(["who_asked"]);
    await sandboxMiddleware.wrapModelCall(
      { tools: [whoAsked], systemMessage: new SystemMessage("") },
      () => undefined,
    );
    const code = "await tools.whoAsked({})";
    const [first, second] = await Promise.all(
      ["first", "second"].map((caller) =>
        sandboxMiddleware.tools[0]!.invoke({ code }, { ...config, metadata: { caller } }),
      ),
    );

    expect(first).toContain("first");
    expect(second).toContain("second");
  }, WORKER_TEST_TIMEOUT_MS);

  it("a cancelled worker's late exit does not fail its replacement", async () => {
    const { tools } = await sandbox();
    const controller = new AbortController();
    const spinning = tools[0]!.invoke(
      { code: "let n = 0; while (true) n++;" },
      { ...config, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 200);
    await expect(spinning).rejects.toThrow(/abort|cancel/);

    expect(await tools[0]!.invoke({ code: "40 + 2" }, config)).toContain("42");
  }, WORKER_TEST_TIMEOUT_MS);
});
