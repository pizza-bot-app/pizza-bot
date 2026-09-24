/**
 * Runs the QuickJS sandbox on a worker thread. Guest code holds whichever thread
 * it runs on for its whole execution — the interrupt deadline aborts it but never
 * yields — so this thread is what keeps the server's event loop answering while
 * an eval works. Bridged tool calls travel back to the parent, which owns the
 * graph execution context they need.
 */
import { parentPort, workerData } from "node:worker_threads";
import { ReplSession, formatReplResult } from "@langchain/quickjs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  EvalWorkerData,
  HostCallRequest,
  HostToWorker,
  WorkerToHost,
} from "./eval-worker-protocol.js";

const port = parentPort;
if (!port) throw new Error("eval-worker.ts must be started as a worker thread");

const data = workerData as EvalWorkerData;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextCallId = 0;

function callHost(message: HostCallRequest): Promise<unknown> {
  const id = ++nextCallId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ ...message, id } as WorkerToHost);
  });
}

/**
 * `ReplSession` reads only `name` and `invoke` off a bridged tool, so a proxy
 * needs nothing more — and a Zod schema could not cross `postMessage` anyway.
 * Upstream still owns the guest-facing naming and the `read_file` line-number
 * strip, because both key off the name carried here.
 */
const tools = data.toolNames.map((name) => ({
  name,
  invoke: (args: unknown) => callHost({ kind: "tool-call", name, args }),
})) as unknown as StructuredToolInterface[];

const session = new ReplSession(data.sessionId, {
  tools,
  maxPtcCalls: data.maxPtcCalls,
  maxResultChars: data.maxResultChars,
  memoryLimitBytes: data.memoryLimitBytes,
  maxStackSizeBytes: data.maxStackSizeBytes,
  sessionId: data.sessionId,
  ...(data.subagentConcurrency > 0 && {
    subagentBridge: {
      maxConcurrency: data.subagentConcurrency,
      dispatch: (input) =>
        callHost({
          kind: "task-call",
          description: input.description,
          subagentType: input.subagentType,
          ...(input.responseSchema !== undefined && { responseSchema: input.responseSchema }),
        }),
    },
  }),
});

port.on("message", (message: HostToWorker) => {
  if (message.kind === "settle") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(message.error));
    else entry.resolve(message.value);
    return;
  }
  void (async () => {
    try {
      // Formatting happens here so only a string crosses back: a dumped guest value
      // can hold shapes `postMessage` refuses to clone.
      const text = formatReplResult(await session.eval(message.code, message.timeoutMs));
      port.postMessage({ kind: "eval-result", id: message.id, text } as WorkerToHost);
    } catch (error) {
      // Without a reply the host would wait out the watchdog on a healthy worker.
      port.postMessage({
        kind: "eval-error",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } as WorkerToHost);
    }
  })();
});
