/**
 * Message shapes exchanged with the sandbox worker. Every field crosses
 * `postMessage`, so all of them must be structured-cloneable — which is why the
 * worker returns an already-formatted string rather than a `ReplResult`.
 */

export interface EvalWorkerData {
  /** Bridged tool names in `ptc` order; the guest `tools.*` namespace mirrors it. */
  toolNames: string[];
  maxPtcCalls: number | null;
  maxResultChars: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  sessionId: string;
  /** Zero disables the guest `task()` global entirely. */
  subagentConcurrency: number;
}

export type HostToWorker =
  | { kind: "eval"; id: number; code: string; timeoutMs: number }
  | { kind: "settle"; id: number; value?: unknown; error?: string };

/** A guest call the host has to satisfy, before the correlation id is attached. */
export type HostCallRequest =
  | { kind: "tool-call"; name: string; args: unknown }
  | {
      kind: "task-call";
      description: string;
      subagentType: string;
      responseSchema?: Record<string, unknown>;
    };

export type WorkerToHost =
  | { kind: "eval-result"; id: number; text: string }
  | { kind: "eval-error"; id: number; error: string }
  | (HostCallRequest & { id: number });
