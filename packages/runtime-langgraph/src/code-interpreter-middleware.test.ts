import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createFilesystemMiddleware, FilesystemBackend } from "deepagents";
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

  describe("bridged read_file past the size cap", () => {
    const LINES = 400;
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "eval-read-cap-"));
      const body = Array.from({ length: LINES }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
      writeFileSync(join(root, "big.log"), body.join("\n"));
      writeFileSync(join(root, "wide.log"), ["one", "two", "x".repeat(10_000), "four", "five"].join("\n"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

    async function readingSandbox(): Promise<WorkerMiddleware> {
      // A 4,000-character cap stands in for the real ~80k one: the whole file is ~20k.
      const filesystem = createFilesystemMiddleware({
        backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
        toolTokenLimitBeforeEvict: 1_000,
      });
      const readFile = filesystem.tools!.find((candidate) => candidate.name === "read_file");
      const sandboxMiddleware = await sandbox(["read_file"]);
      await sandboxMiddleware.wrapModelCall(
        { tools: [readFile], systemMessage: new SystemMessage("") },
        () => undefined,
      );
      return sandboxMiddleware;
    }

    it("returns an uncut page as bare file content", async () => {
      const { tools } = await readingSandbox();
      const output = await tools[0]!.invoke(
        {
          code: `JSON.stringify((await tools.readFile({ file_path: "/big.log", offset: 9, limit: 2 })).split(/\\r?\\n/))`,
        },
        config,
      );

      expect(output).toContain(`["line 10 ${"x".repeat(40)}","line 11 ${"x".repeat(40)}"]`);
    }, WORKER_TEST_TIMEOUT_MS);

    it("fails a cut page with the offset to resume from, so paging loses no line", async () => {
      const { tools } = await readingSandbox();
      const code = `
        const lines = [];
        const cuts = [];
        let offset = 0;
        for (;;) {
          try {
            lines.push(...(await tools.readFile({ file_path: "/big.log", offset, limit: 100000 })).split(/\\r?\\n/));
            break;
          } catch (error) {
            const resume = /offset (\\d+) and limit (\\d+)/.exec(error.message);
            if (!resume) throw error;
            cuts.push(error.message);
            const limit = Number(resume[2]);
            lines.push(...(await tools.readFile({ file_path: "/big.log", offset, limit })).split(/\\r?\\n/));
            offset += limit;
          }
        }
        const numbers = lines.filter(Boolean).map((line) => Number(line.split(" ")[1]));
        const inOrder = numbers.every((n, i) => n === i + 1);
        JSON.stringify({ cuts: cuts.length, firstCut: cuts[0], count: numbers.length, inOrder });
      `;
      const output = await tools[0]!.invoke({ code }, config);
      const result = JSON.parse(/\{.*\}/s.exec(output)![0]) as {
        cuts: number;
        firstCut: string;
        count: number;
        inOrder: boolean;
      };

      expect(result.cuts).toBeGreaterThan(1);
      expect(result.firstCut).toMatch(/size cap.*lines 1-\d+ of 400/);
      expect(result).toMatchObject({ count: LINES, inOrder: true });
    }, WORKER_TEST_TIMEOUT_MS);

    it("fails a line wider than the cap with the offset that skips it", async () => {
      const { tools } = await readingSandbox();
      const code = `
        const lines = [];
        const skipped = [];
        let offset = 0;
        while (offset < 5) {
          try {
            lines.push(...(await tools.readFile({ file_path: "/wide.log", offset, limit: 1 })).split(/\\r?\\n/));
            offset += 1;
          } catch (error) {
            const resume = /continue from offset (\\d+) to skip it/.exec(error.message);
            if (!resume) throw error;
            skipped.push(error.message);
            offset = Number(resume[1]);
          }
        }
        JSON.stringify({ lines: lines.filter(Boolean), skipped });
      `;
      const output = await tools[0]!.invoke({ code }, config);
      const result = JSON.parse(/\{.*\}/s.exec(output)![0]) as {
        lines: string[];
        skipped: string[];
      };

      expect(result.lines).toEqual(["one", "two", "four", "five"]);
      expect(result.skipped).toEqual([
        "Tool 'read_file' failed: line 3 of 5 alone exceeds the read size cap, so it cannot be read whole; continue from offset 3 to skip it",
      ]);
    }, WORKER_TEST_TIMEOUT_MS);
  });
});
