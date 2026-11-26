/**
 * One headless SDK `StreamController` per open graph-run thread. Node status
 * folds checkpoint history (which outlives the server's per-run frame buffer)
 * with the live root `tasks` channel.
 */
import { ASSISTANT_ID } from "@pizza-bot/core";
import { Client, HttpAgentServerAdapter, type DefaultValues } from "@langchain/langgraph-sdk";
import {
  StreamController,
  channelProjection,
  messagesProjection,
  type AcquiredProjection,
  type Event,
  type RootSnapshot,
} from "@langchain/langgraph-sdk/stream";
import {
  buildBatchResumeCommand,
  foldGraphRun,
  messagesToUI,
  parseInterruptActions,
  taskFrameFromEvent,
  taskFramesFromHistory,
  type GraphNodeRuns,
  type PendingInterrupt,
  type RawMessage,
  type TaskFrame,
  type UIMessageLike,
} from "@/projection";
import { ApiClient } from "./api-client.js";
import { resolveApiBase, resolveApiHeaders } from "./api-config.js";

export type GraphRunStatus = "loading" | "running" | "paused" | "idle" | "error";

export interface GraphRunSnapshot {
  status: GraphRunStatus;
  frames: TaskFrame[];
  runs: GraphNodeRuns;
  interrupts: PendingInterrupt[];
  values: Record<string, unknown>;
  errorText?: string | undefined;
}

export interface AgentTranscriptHandle {
  subscribe: (cb: () => void) => () => void;
  getMessages: () => UIMessageLike[] | null;
  release: () => void;
}

const EMPTY: GraphRunSnapshot = {
  status: "loading",
  frames: [],
  runs: {},
  interrupts: [],
  values: {},
};

// The server caps one history page at 100 checkpoints.
const HISTORY_LIMIT = 100;

interface Entry {
  client: Client;
  controller: StreamController<DefaultValues>;
  tasks: AcquiredProjection<Event[]>;
  release: () => void;
  unsub: Array<() => void>;
  historyFrames: TaskFrame[];
  historyError?: unknown;
  hydrated: boolean;
  wasLoading: boolean;
}

export class GraphRunStore {
  private readonly entries = new Map<string, Entry>();
  private readonly snapshots = new Map<string, GraphRunSnapshot>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly apiBase = resolveApiBase();
  private readonly apiHeaders = resolveApiHeaders();
  private readonly apiClient = new ApiClient({ baseUrl: this.apiBase, headers: this.apiHeaders });

  getSnapshot(threadId: string): GraphRunSnapshot {
    return this.snapshots.get(threadId) ?? EMPTY;
  }

  subscribe(threadId: string, listener: () => void): () => void {
    let set = this.listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.listeners.set(threadId, set);
    }
    set.add(listener);
    this.attach(threadId);
    return () => {
      set!.delete(listener);
      if (set!.size > 0) return;
      this.listeners.delete(threadId);
      this.dispose(threadId);
    };
  }

  async respond(threadId: string, interruptId: string, response: unknown): Promise<void> {
    const e = this.entries.get(threadId);
    if (!e) return;
    await e.controller.respond({ interruptId, response }, { interruptId, namespace: [] });
  }

  async decide(threadId: string, interrupt: PendingInterrupt, decision: "approve" | "reject"): Promise<void> {
    const e = this.entries.get(threadId);
    if (!e) return;
    // The approval middleware rejects a batch whose decision count does not match.
    const { actions } = parseInterruptActions(interrupt.value);
    const command = buildBatchResumeCommand(interrupt.id, decision, actions.length);
    await e.controller.respond(command, { interruptId: interrupt.id, namespace: [] });
  }

  async stop(threadId: string): Promise<void> {
    await this.apiClient.stopRun(threadId);
  }

  /**
   * Live transcript of an agent node's subgraph. The server keeps a run's frames
   * only briefly after it ends, so an older run yields no messages.
   */
  openAgentTranscript(threadId: string, namespace: readonly string[]): AgentTranscriptHandle {
    // A child's effect can run before the pane's subscription attaches the thread.
    this.attach(threadId);
    const e = this.entries.get(threadId)!;
    const acquired = e.controller.registry.acquire(messagesProjection(namespace));
    let lastRaw: unknown;
    let lastFolded: UIMessageLike[] | null = null;
    let released = false;
    return {
      subscribe: (cb) => acquired.store.subscribe(cb),
      getMessages: () => {
        const raw = acquired.store.getSnapshot();
        if (raw !== lastRaw) {
          lastRaw = raw;
          lastFolded = raw.length > 0 ? messagesToUI(raw as unknown as RawMessage[]) : null;
        }
        return lastFolded;
      },
      release: () => {
        if (released) return;
        released = true;
        acquired.release();
      },
    };
  }

  private attach(threadId: string): void {
    if (this.entries.has(threadId)) return;
    const client = new Client({ apiUrl: this.apiBase, defaultHeaders: this.apiHeaders });
    const controller = new StreamController<DefaultValues>({
      assistantId: ASSISTANT_ID,
      client,
      threadId,
      transport: new HttpAgentServerAdapter({
        apiUrl: this.apiBase,
        threadId,
        defaultHeaders: this.apiHeaders,
      }),
    });
    const release = controller.activate();
    const tasks = controller.registry.acquire(channelProjection(["tasks"], []));
    const recompute = () => this.recompute(threadId);
    const e: Entry = {
      client,
      controller,
      tasks,
      release,
      unsub: [controller.rootStore.subscribe(recompute), tasks.store.subscribe(recompute)],
      historyFrames: [],
      hydrated: false,
      wasLoading: false,
    };
    this.entries.set(threadId, e);
    this.recompute(threadId);
    void controller
      .hydrate(threadId)
      .catch(() => {
        // The root snapshot carries the hydration error.
      })
      .then(() => this.loadHistory(threadId, e));
  }

  private async loadHistory(threadId: string, e: Entry): Promise<void> {
    try {
      const history = await e.client.threads.getHistory(threadId, { limit: HISTORY_LIMIT });
      e.historyFrames = taskFramesFromHistory(history);
      e.historyError = undefined;
    } catch (error) {
      e.historyError = error;
    }
    e.hydrated = true;
    if (this.entries.get(threadId) === e) this.recompute(threadId);
  }

  private recompute(threadId: string): void {
    const e = this.entries.get(threadId);
    if (!e) return;
    const root = e.controller.rootStore.getSnapshot() as RootSnapshot;
    // A finished run's checkpoints are the durable record; reread them once it settles.
    if (e.wasLoading && !root.isLoading) void this.loadHistory(threadId, e);
    e.wasLoading = root.isLoading;

    const live = e.tasks.store.getSnapshot().flatMap((event) => {
      const frame = taskFrameFromEvent(event);
      return frame ? [frame] : [];
    });
    const frames = [...e.historyFrames, ...live];
    const interrupts = root.interrupts.flatMap((it) =>
      typeof it.id === "string" ? [{ id: it.id, value: it.value }] : [],
    );
    const error = root.error ?? e.historyError;
    const status: GraphRunStatus = !e.hydrated
      ? "loading"
      : error !== undefined && error !== null
        ? "error"
        : root.isLoading
          ? "running"
          : interrupts.length > 0
            ? "paused"
            : "idle";
    const next: GraphRunSnapshot = {
      status,
      frames,
      runs: foldGraphRun(frames, root.isLoading),
      interrupts,
      values: (root.values ?? {}) as Record<string, unknown>,
      errorText: status === "error" ? errorMessage(error) : undefined,
    };
    const prev = this.snapshots.get(threadId);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    this.snapshots.set(threadId, next);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }

  private dispose(threadId: string): void {
    const e = this.entries.get(threadId);
    if (!e) return;
    for (const unsub of e.unsub) unsub();
    e.tasks.release();
    e.release();
    this.entries.delete(threadId);
    this.snapshots.delete(threadId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const graphRunStore = new GraphRunStore();
