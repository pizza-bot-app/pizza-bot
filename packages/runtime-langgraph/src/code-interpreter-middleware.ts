/**
 * Hosts upstream's code-interpreter middleware with its QuickJS guest moved onto
 * a worker thread. Upstream stays authoritative for the eval tool's schema, the
 * prompts it injects and its result formatting; this file owns only the thread
 * boundary and the bridged calls that have to come back across it.
 */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { isCommand } from "@langchain/langgraph";
import { SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY } from "deepagents";
import type { EvalWorkerData, HostToWorker, WorkerToHost } from "./eval-worker-protocol.js";

export interface SandboxOptions {
  ptc: string[];
  maxResultChars: number;
  executionTimeoutMs: number;
  subagents: boolean;
}

/** Mirrors the fixed cap upstream applies when `subagents` is enabled. */
const SUBAGENT_CONCURRENCY = 32;

/** Grace past the guest deadline before a silent worker counts as wedged. */
const WORKER_RESPONSE_GRACE_MS = 10_000;

/**
 * Under tsx and vitest this module is still TypeScript, so the worker beside it
 * is too and needs the same loader; the packaged server is one esbuild bundle
 * whose sibling worker entry is emitted as plain JS.
 */
const FROM_SOURCE = import.meta.url.endsWith(".ts");
const WORKER_ENTRY = new URL(
  FROM_SOURCE ? "./eval-worker.ts" : "./eval-worker.js",
  import.meta.url,
);
const WORKER_EXEC_ARGV = FROM_SOURCE ? ["--import", "tsx"] : [];

interface ToolLike {
  name: string;
  invoke: (args: Record<string, unknown>, config?: RunnableConfig) => Promise<unknown>;
}

/**
 * Reduce a `Command` / message envelope to the content inside it. The guest
 * needs the content rather than the envelope, and an envelope cannot cross
 * `postMessage`; the worker still turns this into the final text, so the
 * guest-facing formatting stays upstream's.
 */
function unwrapToolEnvelope(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (isCommand(value)) {
    const inner = commandContent(value);
    return inner === value ? value : unwrapToolEnvelope(inner);
  }
  if (BaseMessage.isInstance(value)) return unwrapToolEnvelope(value.content);
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const entry = value[i];
      if (BaseMessage.isInstance(entry)) return unwrapToolEnvelope(entry.content);
      if (isCommand(entry)) {
        const inner = commandContent(entry);
        if (inner !== entry) return unwrapToolEnvelope(inner);
      }
    }
  }
  return value;
}

function commandContent(command: { update?: unknown }): unknown {
  const update = command.update;
  const messages =
    update !== null && typeof update === "object"
      ? (update as { messages?: unknown }).messages
      : undefined;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (BaseMessage.isInstance(message) && message.content != null) return message.content;
    }
  }
  return command;
}

interface SandboxSession {
  worker: Worker;
  /** Refreshed per eval: a bridged call must run under the calling run's config. */
  config: RunnableConfig;
  pendingEvals: Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>;
}

export async function createWorkerCodeInterpreterMiddleware(
  options: SandboxOptions,
): Promise<unknown> {
  const {
    createCodeInterpreterMiddleware,
    validateResponseSchema,
    DEFAULT_MAX_PTC_CALLS,
    DEFAULT_MEMORY_LIMIT,
    DEFAULT_MAX_STACK_SIZE,
  } = await import("@langchain/quickjs");

  const upstream = createCodeInterpreterMiddleware(options);
  const template = upstream.tools?.[0];
  if (upstream.tools?.length !== 1 || template === undefined) {
    throw new Error(
      "@langchain/quickjs no longer contributes exactly one tool; the worker-hosted " +
        "sandbox wraps that tool and must be revisited.",
    );
  }

  const middlewareId = randomUUID();
  const sessions = new Map<string, SandboxSession>();
  let ptcTools: ToolLike[] = [];
  let taskTool: ToolLike | null = null;
  let nextEvalId = 0;

  function disposeSession(key: string, reason?: Error): void {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    for (const waiter of session.pendingEvals.values()) {
      waiter.reject(reason ?? new Error("the sandbox worker was shut down"));
    }
    session.pendingEvals.clear();
    void session.worker.terminate();
  }

  async function settleHostCall(
    session: SandboxSession,
    message: Extract<WorkerToHost, { kind: "tool-call" | "task-call" }>,
  ): Promise<void> {
    const reply = (payload: HostToWorker) => {
      try {
        session.worker.postMessage(payload);
      } catch {
        // The worker is already gone; its pending guest calls die with it.
      }
    };
    try {
      if (message.kind === "tool-call") {
        const target = ptcTools.find((candidate) => candidate.name === message.name);
        if (!target) throw new Error(`tool '${message.name}' is not bridged into the sandbox`);
        // The config is passed explicitly because this handler runs from the
        // worker's message event, outside the eval call's async context — the
        // graph context a filesystem write needs would otherwise be missing.
        const raw = await target.invoke(
          (typeof message.args === "object" && message.args !== null
            ? message.args
            : {}) as Record<string, unknown>,
          session.config,
        );
        reply({ kind: "settle", id: message.id, value: unwrapToolEnvelope(raw) });
        return;
      }
      if (!taskTool) throw new Error("subagent dispatch is not available in this sandbox");
      const responseSchema = message.responseSchema;
      if (responseSchema !== undefined) validateResponseSchema(responseSchema);
      const config: RunnableConfig =
        responseSchema === undefined
          ? session.config
          : {
              ...session.config,
              configurable: {
                ...session.config.configurable,
                [SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY]: responseSchema,
              },
            };
      const content = unwrapToolEnvelope(
        await taskTool.invoke(
          { description: message.description, subagent_type: message.subagentType },
          config,
        ),
      );
      const value =
        responseSchema !== undefined && typeof content === "string"
          ? tryParseJson(content)
          : content;
      reply({ kind: "settle", id: message.id, value });
    } catch (error) {
      reply({
        kind: "settle",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function startSession(key: string, config: RunnableConfig): SandboxSession {
    const workerData: EvalWorkerData = {
      toolNames: ptcTools.map((candidate) => candidate.name),
      maxPtcCalls: DEFAULT_MAX_PTC_CALLS,
      maxResultChars: options.maxResultChars,
      memoryLimitBytes: DEFAULT_MEMORY_LIMIT,
      maxStackSizeBytes: DEFAULT_MAX_STACK_SIZE,
      sessionId: key,
      subagentConcurrency: options.subagents && taskTool ? SUBAGENT_CONCURRENCY : 0,
    };
    const worker = new Worker(WORKER_ENTRY, { workerData, execArgv: WORKER_EXEC_ARGV });
    // A wedged sandbox must never be the reason the process cannot exit.
    worker.unref();
    const session: SandboxSession = { worker, config, pendingEvals: new Map() };
    worker.on("message", (message: WorkerToHost) => {
      if (message.kind === "eval-result") {
        const waiter = session.pendingEvals.get(message.id);
        session.pendingEvals.delete(message.id);
        waiter?.resolve(message.text);
        return;
      }
      void settleHostCall(session, message);
    });
    worker.on("error", (error: unknown) =>
      disposeSession(key, error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", (code) => {
      if (code !== 0) disposeSession(key, new Error(`the sandbox worker exited with code ${code}`));
    });
    sessions.set(key, session);
    return session;
  }

  const evalTool = tool(
    async (input: { code: string }, config: RunnableConfig): Promise<string> => {
      const key = `${config.configurable?.thread_id ?? "__default__"}:${middlewareId}`;
      const session = sessions.get(key) ?? startSession(key, config);
      // The tool list is fixed when the worker starts, so only the config moves.
      session.config = config;

      const id = ++nextEvalId;
      return await new Promise<string>((resolve, reject) => {
        const settle = () => {
          clearTimeout(watchdog);
          config.signal?.removeEventListener("abort", onAbort);
          session.pendingEvals.delete(id);
        };
        const onAbort = () => {
          settle();
          // Terminating is the only way to stop guest code that never awaits, and
          // discarding the whole isolate avoids upstream's dispose-during-GC crash.
          disposeSession(key, new Error("the run was cancelled"));
          reject(new Error("the sandbox run was cancelled"));
        };
        const watchdog = setTimeout(() => {
          settle();
          disposeSession(key);
          reject(new Error("the sandbox worker stopped responding and was restarted"));
        }, options.executionTimeoutMs + WORKER_RESPONSE_GRACE_MS);
        session.pendingEvals.set(id, {
          resolve: (text) => {
            settle();
            resolve(text);
          },
          reject: (error) => {
            settle();
            reject(error);
          },
        });
        config.signal?.addEventListener("abort", onAbort, { once: true });
        session.worker.postMessage({
          kind: "eval",
          id,
          code: input.code,
          timeoutMs: options.executionTimeoutMs,
        } satisfies HostToWorker);
      });
    },
    {
      name: template.name,
      description: template.description,
      schema: template.schema,
      ...(template.metadata !== undefined && { metadata: template.metadata }),
    },
  );

  return {
    ...upstream,
    tools: [evalTool],
    wrapModelCall: async (
      request: { tools?: ToolLike[] },
      handler: (request: unknown) => unknown,
    ) => {
      const agentTools = request.tools ?? [];
      const byName = new Map(
        agentTools.filter((candidate) => candidate.name !== template.name)
          .map((candidate) => [candidate.name, candidate]),
      );
      ptcTools = options.ptc
        .map((name) => byName.get(name))
        .filter((candidate): candidate is ToolLike => candidate !== undefined);
      taskTool = agentTools.find((candidate) => candidate.name === "task") ?? taskTool;
      // Upstream still builds the system prompt, including the generated `tools.*`
      // type declarations, off the same tool list.
      return await (upstream.wrapModelCall as (r: unknown, h: unknown) => Promise<unknown>)(
        request,
        handler,
      );
    },
    afterAgent: async (state: unknown, runtime: { configurable?: { thread_id?: string } }) => {
      disposeSession(`${runtime.configurable?.thread_id ?? "__default__"}:${middlewareId}`);
      return await (
        upstream.afterAgent as
          | ((s: unknown, r: unknown) => Promise<unknown>)
          | undefined
      )?.(state, runtime);
    },
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
