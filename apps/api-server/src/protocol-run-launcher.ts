import type { RunHandle, RunInput, RunOptions } from "@pizza-bot/core";
import type { ProtocolRunManager } from "./protocol-run-manager.js";
import type { RunLauncher, RunScopedEvent } from "./trigger-service.js";
import type { Unsubscribe } from "./emitter.js";

export function protocolRunLauncher(runs: ProtocolRunManager): RunLauncher {
  return {
    start(threadId: string, input: RunInput, opts?: Partial<RunOptions>): RunHandle {
      const { runId } = runs.start(threadId, input, opts);
      return { runId, threadId, status: "running", startedAt: Date.now() };
    },
    subscribe(listener: (evt: RunScopedEvent) => void): Unsubscribe {
      return runs.onEnd(({ runId, threadId, status }) => {
        listener({ runId, threadId, event: { type: "run-end", runId, status } });
      });
    },
  };
}
