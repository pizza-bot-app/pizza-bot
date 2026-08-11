import { ASSISTANT_ID, classifyError, type HitlDecision, type AttachmentMeta } from "@pizza-bot/core";
import {
  buildBatchResumeCommand,
  messagesToUI,
  sealOpenToolCalls,
  usageFromMessages,
  overlayInterrupt,
  parseInterruptActions,
  type ThreadSlice,
  type StreamStatus,
  type RawMessage,
  type DelegationInfo,
  type UIMessageLike,
} from "@/projection";
import { Client, HttpAgentServerAdapter, type DefaultValues } from "@langchain/langgraph-sdk";
import {
  StreamController,
  messagesProjection,
  type RootSnapshot,
  type SubagentMap,
} from "@langchain/langgraph-sdk/stream";
import { ApiClient } from "./api-client.js";
import { resolveApiBase, resolveApiHeaders } from "./api-config.js";

// Controllers live outside React so background threads continue while only the
// active pane is mounted.
const EMPTY_SLICE: ThreadSlice = {
  messages: [],
  delegations: {},
  status: "idle",
  errorText: undefined,
  errorCode: undefined,
  attached: false,
  queued: [],
  usage: undefined,
};

export type HydrationStatus = "unattached" | "loading" | "ready" | "error";

export interface ProtocolThreadSlice extends ThreadSlice {
  hydrationStatus: HydrationStatus;
  hydrationError?: string | undefined;
}

const EMPTY_PROTOCOL_SLICE: ProtocolThreadSlice = {
  ...EMPTY_SLICE,
  hydrationStatus: "unattached",
  hydrationError: undefined,
};

// Each SDK run holds two HTTP/1.1 SSE sockets; leave capacity for commands and metadata.
const MAX_PARALLEL_BROWSER_RUNS = 2;

interface ThreadEntry {
  threadId: string;
  client: Client;
  controller: StreamController<DefaultValues>;
  release: () => void;
  unsub: Array<() => void>;
  needsInitialBinding: boolean;
  draftHydration: { bypassStateRead: boolean };
  hydrationStatus: HydrationStatus;
  hydrationError?: unknown;
  hydrationPromise?: Promise<void>;
  resolvedHydrationError?: unknown;
  runId?: string;
  queued: QueuedSteer[];
  steerCancellationPending: boolean;
  // HITL resumes require one decision per gated call in the current interrupt.
  pendingInterruptCount?: number;
  // Replayed delegation timestamps reflect page load, not actual execution.
  liveDelegationIds: Set<string>;
  lastAccessed: number;
}

export interface SubagentTranscriptHandle {
  subscribe: (cb: () => void) => () => void;
  getMessages: () => UIMessageLike[];
  release: () => void;
}

interface QueuedSteer {
  text: string;
  model?: string;
  attachments?: AttachmentMeta[];
}

export class ProtocolStreamStore {
  private readonly entries = new Map<string, ThreadEntry>();
  private readonly slices = new Map<string, ProtocolThreadSlice>();
  private readonly persistedThreadIds = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly globalListeners = new Set<() => void>();
  private readonly runCompletionListeners = new Set<(threadId: string) => void>();
  private readonly activeRunThreads = new Set<string>();
  private readonly pendingRunThreads: string[] = [];
  private readonly pendingRunThreadSet = new Set<string>();
  private knownSnapshot: string[] = [];
  private runningSnapshot: string[] = [];
  private readonly apiBase = resolveApiBase();
  private readonly apiHeaders = resolveApiHeaders();
  private readonly apiClient = new ApiClient({
    baseUrl: this.apiBase,
    headers: this.apiHeaders,
  });

  constructor(
    private readonly maxInactiveControllers = 12,
    private readonly maxParallelRuns = MAX_PARALLEL_BROWSER_RUNS,
  ) {}

  getSlice(threadId: string | null): ProtocolThreadSlice {
    return (threadId ? this.slices.get(threadId) : undefined) ?? EMPTY_PROTOCOL_SLICE;
  }

  subscribe(threadId: string, listener: () => void): () => void {
    let set = this.listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.listeners.set(threadId, set);
    }
    set.add(listener);
    const entry = this.entries.get(threadId);
    if (entry) entry.lastAccessed = Date.now();
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(threadId);
      this.disposeIdleController(threadId);
      this.evictInactiveControllers();
    };
  }

  subscribeGlobal(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  subscribeRunCompletions(listener: (threadId: string) => void): () => void {
    this.runCompletionListeners.add(listener);
    return () => this.runCompletionListeners.delete(listener);
  }

  knownThreadIds(): string[] {
    const next = [...this.slices.keys()];
    const prev = this.knownSnapshot;
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
    this.knownSnapshot = next;
    return next;
  }

  // useSyncExternalStore requires snapshot identity to remain stable when unchanged.
  runningThreadIds(): string[] {
    const next: string[] = [];
    for (const [id, slice] of this.slices) if (slice.status === "streaming") next.push(id);
    const prev = this.runningSnapshot;
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
    this.runningSnapshot = next;
    return next;
  }

  private entry(threadId: string, persisted = false): ThreadEntry {
    let e = this.entries.get(threadId);
    if (e) {
      e.lastAccessed = Date.now();
      return e;
    }
    const serverBacked = persisted || this.persistedThreadIds.has(threadId);
    const client = new Client({ apiUrl: this.apiBase, defaultHeaders: this.apiHeaders });
    const transport = new HttpAgentServerAdapter({
      apiUrl: this.apiBase,
      ...(serverBacked ? { threadId } : {}),
      defaultHeaders: this.apiHeaders,
    });
    const draftHydration = { bypassStateRead: false };
    if (!serverBacked && transport.getState) {
      const getState = transport.getState.bind(transport);
      transport.getState = async () => {
        if (draftHydration.bypassStateRead) {
          draftHydration.bypassStateRead = false;
          return null;
        }
        return getState();
      };
    }
    const controller = new StreamController({
      assistantId: ASSISTANT_ID,
      client,
      ...(serverBacked ? { threadId } : {}),
      transport,
      // The server replaces client message IDs, so SDK optimistic echoes would
      // survive beside the committed message and render the user turn twice.
      optimistic: false,
      onCreated: (info) => {
        this.persistedThreadIds.add(threadId);
        const ent = this.entries.get(threadId);
        if (ent) ent.runId = info.runId;
        this.recompute(threadId);
      },
      onCompleted: () => {
        const ent = this.entries.get(threadId);
        const completedLocalRun = ent?.runId !== undefined;
        if (ent) ent.runId = undefined;
        this.activeRunThreads.delete(threadId);
        this.recompute(threadId);
        if (completedLocalRun) {
          for (const listener of this.runCompletionListeners) listener(threadId);
        }
        this.drainQueued(threadId);
        this.disposeIdleController(threadId);
        this.evictInactiveControllers();
        this.pumpRunQueue();
      },
    });
    // The store owns controller lifetime independently of the active pane.
    const release = controller.activate();
    const recompute = () => this.recompute(threadId);
    const unsub = [
      controller.rootStore.subscribe(recompute),
      controller.subagentStore.subscribe(recompute),
    ];
    e = {
      threadId,
      client,
      controller,
      release,
      unsub,
      needsInitialBinding: !serverBacked,
      draftHydration,
      hydrationStatus: "unattached",
      queued: [],
      steerCancellationPending: false,
      liveDelegationIds: new Set(),
      lastAccessed: Date.now(),
    };
    this.entries.set(threadId, e);
    this.evictInactiveControllers(threadId);
    return e;
  }

  disposeThread(threadId: string): void {
    this.disposeController(threadId);
    this.activeRunThreads.delete(threadId);
    this.pendingRunThreadSet.delete(threadId);
    this.persistedThreadIds.delete(threadId);
    this.slices.delete(threadId);
    this.listeners.delete(threadId);
    this.runningSnapshot = this.runningSnapshot.filter((id) => id !== threadId);
    for (const listener of this.globalListeners) listener();
    this.pumpRunQueue();
  }

  private disposeController(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    for (const unsub of entry.unsub) unsub();
    entry.release();
    this.entries.delete(threadId);
  }

  private disposeIdleController(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    const status = this.slices.get(threadId)?.status;
    if (
      entry.runId ||
      this.activeRunThreads.has(threadId) ||
      entry.hydrationPromise ||
      entry.steerCancellationPending ||
      entry.queued.length > 0 ||
      (this.listeners.get(threadId)?.size ?? 0) > 0 ||
      status === "streaming" ||
      status === "interrupted"
    ) {
      return;
    }
    this.disposeController(threadId);
  }

  // Bound live controllers: evict only fully-idle, unobserved threads (their
  // slice survives for reopen; the SDK rehydrates from the server on demand).
  private evictInactiveControllers(preserveThreadId?: string): void {
    if (this.entries.size <= this.maxInactiveControllers) return;
    const candidates = [...this.entries.entries()]
      .filter(([threadId, entry]) => {
        if (threadId === preserveThreadId) return false;
        const status = this.slices.get(threadId)?.status;
        return (
          !entry.runId &&
          !this.activeRunThreads.has(threadId) &&
          !entry.hydrationPromise &&
          !entry.steerCancellationPending &&
          entry.queued.length === 0 &&
          (this.listeners.get(threadId)?.size ?? 0) === 0 &&
          status !== "streaming" &&
          status !== "interrupted"
        );
      })
      .sort(([, left], [, right]) => left.lastAccessed - right.lastAccessed);
    for (const [threadId] of candidates) {
      if (this.entries.size <= this.maxInactiveControllers) break;
      this.disposeController(threadId);
    }
  }

  private recompute(threadId: string): void {
    const e = this.entries.get(threadId);
    if (!e) return;
    const root = e.controller.rootStore.getSnapshot() as RootSnapshot;
    const subagents = e.controller.subagentStore.getSnapshot() as SubagentMap;

    const rawMessages = root.messages as unknown as RawMessage[];
    let messages: UIMessageLike[] = messagesToUI(rawMessages, threadId);

    const usage = usageFromMessages(rawMessages);

    if (root.interrupt) {
      const { actions, allowedDecisions } = parseInterruptActions(root.interrupt.value);
      messages = overlayInterrupt(messages, root.interrupt.id ?? "interrupt", actions, allowedDecisions);
      e.pendingInterruptCount = actions.length;
    } else {
      e.pendingInterruptCount = undefined;
    }

    const batchByCallId = taskCallBatches(rawMessages);
    const taskErrors = taskCallErrors(rawMessages);
    const delegations: Record<string, DelegationInfo> = {};
    for (const s of subagents.values()) {
      const batchId = batchByCallId.get(s.id);
      const taskError = taskErrors.get(s.id);
      if (root.isLoading) e.liveDelegationIds.add(s.id);
      const live = e.liveDelegationIds.has(s.id);
      delegations[s.id] = {
        delegationId: s.id,
        subagent: s.name,
        ...(s.taskInput ? { title: s.taskInput } : {}),
        status:
          taskError !== undefined || s.status === "error"
            ? "error"
            : s.status === "complete"
              ? "completed"
              : "running",
        ...(s.output !== undefined ? { output: s.output } : {}),
        ...(s.error || taskError ? { errorText: s.error ?? taskError } : {}),
        ...(live && s.startedAt ? { startedAt: s.startedAt.getTime() } : {}),
        ...(live && s.completedAt ? { completedAt: s.completedAt.getTime() } : {}),
        parentId: s.parentId,
        depth: s.depth,
        ...(batchId ? { batchId } : {}),
      };
    }

    // Cancellation has no error payload and intentionally resolves to idle.
    // Temporary SDK compatibility path. Exit criteria: remove when a successful
    // StreamController hydration clears the preceding root error.
    const rootError =
      root.error && root.error !== e.resolvedHydrationError ? root.error : undefined;
    const status: StreamStatus = e.hydrationStatus === "error" || rootError
      ? "error"
      : root.interrupt
        ? "interrupted"
        : root.isLoading
          ? "streaming"
          : "idle";

    // The run error wins over the hydration error: it reflects the user's most
    // recent action (a failed send), while hydration failed on thread open.
    const surfacedError =
      rootError ?? (e.hydrationStatus === "error" ? e.hydrationError : undefined);
    const errorText = status === "error" ? errorMessage(surfacedError) : undefined;
    const errorCode = errorText !== undefined ? classifyError(surfacedError) : undefined;

    if (e.hydrationStatus === "ready" && !root.isLoading && !root.interrupt) {
      messages = sealOpenToolCalls(messages);
    }

    const next: ProtocolThreadSlice = {
      messages,
      delegations,
      status,
      errorText,
      errorCode,
      ...(e.runId ? { runId: e.runId } : { runId: undefined }),
      attached: e.hydrationStatus === "ready",
      hydrationStatus: e.hydrationStatus,
      hydrationError:
        e.hydrationStatus === "error" ? errorMessage(e.hydrationError) : undefined,
      queued: e.queued.map((q) => q.text),
      usage,
    };
    this.commit(threadId, next);
  }

  private commit(threadId: string, next: ProtocolThreadSlice): void {
    const prev = this.slices.get(threadId);
    if (prev && sliceEqual(prev, next)) return;
    this.slices.set(threadId, next);
    const set = this.listeners.get(threadId);
    if (set) for (const l of set) l();
    for (const l of this.globalListeners) l();
  }

  async attach(threadId: string, hydrate: boolean): Promise<void> {
    if (hydrate) this.persistedThreadIds.add(threadId);
    const e = this.entry(threadId, hydrate);
    if (e.hydrationStatus === "ready") return;
    if (e.hydrationPromise) return e.hydrationPromise;
    if (!hydrate) {
      e.hydrationStatus = "ready";
      e.hydrationError = undefined;
      this.recompute(threadId);
      return;
    }

    const previousHydrationError = e.hydrationError;
    e.hydrationStatus = "loading";
    e.hydrationError = undefined;
    e.resolvedHydrationError = previousHydrationError;
    this.recompute(threadId);

    const promise = (async () => {
      try {
        await e.controller.hydrate(threadId);
        e.hydrationStatus = "ready";
        e.hydrationError = undefined;
      } catch (err) {
        if (httpStatus(err) === 404) {
          e.resolvedHydrationError = err;
          e.hydrationStatus = "ready";
          e.hydrationError = undefined;
        } else {
          e.hydrationStatus = "error";
          e.hydrationError = err;
          throw err;
        }
      } finally {
        e.hydrationPromise = undefined;
        this.recompute(threadId);
      }
    })();
    e.hydrationPromise = promise;
    return promise;
  }

  async send(
    threadId: string,
    text: string,
    model?: string,
    attachments?: AttachmentMeta[],
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && !attachments?.length) return;
    const e = this.entry(threadId);
    const pending = {
      text: trimmed,
      ...(model ? { model } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
    // Ordinary input cannot resume HITL; retain it until the interrupt settles.
    const status = this.getSlice(threadId).status;
    if (
      status === "streaming" ||
      status === "interrupted" ||
      this.activeRunThreads.has(threadId) ||
      this.pendingRunThreadSet.has(threadId) ||
      e.queued.length > 0 ||
      this.activeRunThreads.size >= this.maxParallelRuns
    ) {
      e.queued.push(pending);
      this.recompute(threadId);
      this.drainQueued(threadId);
      return;
    }
    this.activeRunThreads.add(threadId);
    try {
      await this.submitTurn(e, trimmed, model, attachments);
    } finally {
      if (!e.runId && this.activeRunThreads.delete(threadId)) {
        this.pumpRunQueue();
      }
    }
  }

  private async submitTurn(
    e: ThreadEntry,
    text: string,
    model?: string,
    attachments?: AttachmentMeta[],
  ): Promise<void> {
    const configurable = { ...(model ? { model } : {}) };
    const bindDraft = e.needsInitialBinding;
    if (bindDraft) {
      e.needsInitialBinding = false;
      // The SDK hydrates explicit thread-id overrides before dispatch. A draft
      // has no server state yet, so let that one binding hydrate resolve locally.
      e.draftHydration.bypassStateRead = true;
    }
    const message = attachments?.length
      ? {
          role: "user" as const,
          parts: [
            ...(text ? [{ type: "text", text }] : []),
            ...attachments.map((a) => ({
              type: "file" as const,
              url: a.url,
              mediaType: a.mediaType,
              name: a.filename,
              sizeBytes: a.sizeBytes,
            })),
          ],
        }
      : { role: "user" as const, content: text };
    const options = {
      ...(Object.keys(configurable).length > 0 ? { config: { configurable } } : {}),
      ...(bindDraft ? { threadId: e.threadId } : {}),
    };
    try {
      await e.controller.submit(
        { messages: [message] },
        Object.keys(options).length > 0 ? options : undefined,
      );
    } finally {
      e.draftHydration.bypassStateRead = false;
    }
  }

  private drainQueued(threadId: string): void {
    const e = this.entries.get(threadId);
    if (!e || e.queued.length === 0) return;
    if (e.steerCancellationPending) return;
    const status = this.getSlice(threadId).status;
    if (status === "streaming" || status === "interrupted") return;
    if (this.activeRunThreads.has(threadId)) return;
    if (!this.pendingRunThreadSet.has(threadId)) {
      this.pendingRunThreadSet.add(threadId);
      this.pendingRunThreads.push(threadId);
    }
    this.pumpRunQueue();
  }

  private pumpRunQueue(): void {
    while (
      this.activeRunThreads.size < this.maxParallelRuns &&
      this.pendingRunThreads.length > 0
    ) {
      const threadId = this.pendingRunThreads.shift();
      if (!threadId) return;
      this.pendingRunThreadSet.delete(threadId);
      const e = this.entries.get(threadId);
      if (!e || e.queued.length === 0 || this.activeRunThreads.has(threadId)) continue;
      const status = this.getSlice(threadId).status;
      if (
        e.steerCancellationPending ||
        status === "streaming" ||
        status === "interrupted"
      ) {
        continue;
      }
      const pending = e.queued.shift();
      if (!pending) continue;
      this.recompute(threadId);
      this.activeRunThreads.add(threadId);
      void this.submitQueuedTurn(threadId, e, pending);
    }
  }

  private async submitQueuedTurn(
    threadId: string,
    e: ThreadEntry,
    pending: QueuedSteer,
  ): Promise<void> {
    let failed = false;
    try {
      await this.submitTurn(
        e,
        pending.text,
        pending.model,
        pending.attachments,
      );
    } catch (err) {
      failed = true;
      // Never discard input after a transient submit failure.
      e.queued.unshift(pending);
      this.recompute(threadId);
      console.error(`[stream] failed to submit queued turn for ${threadId}:`, err);
    } finally {
      if (!e.runId && this.activeRunThreads.delete(threadId)) {
        if (!failed) this.drainQueued(threadId);
        this.pumpRunQueue();
      }
    }
  }

  cancelQueued(threadId: string, index: number): void {
    const e = this.entries.get(threadId);
    if (!e || index < 0 || index >= e.queued.length) return;
    e.queued.splice(index, 1);
    this.recompute(threadId);
  }

  async steerNow(
    threadId: string,
    text: string,
    model?: string,
    attachments?: AttachmentMeta[],
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && !attachments?.length) return;
    const e = this.entry(threadId);
    const status = this.getSlice(threadId).status;
    if (status === "interrupted") {
      e.queued.push({
        text: trimmed,
        ...(model ? { model } : {}),
        ...(attachments?.length ? { attachments } : {}),
      });
      this.recompute(threadId);
      return;
    }
    if (status !== "streaming") {
      await this.send(threadId, trimmed, model, attachments);
      return;
    }
    e.queued.push({
      text: trimmed,
      ...(model ? { model } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
    this.recompute(threadId);
    // Temporary strict-cancel path. Exit criteria: replace this with
    // controller.stop() when it propagates server cancellation failures.
    e.steerCancellationPending = true;
    try {
      if (!e.runId) {
        throw new Error("cannot steer until the active run id is available");
      }
      await e.client.runs.cancel(threadId, e.runId, true);
      await e.controller.stop({ cancel: false });
    } catch (err) {
      e.steerCancellationPending = false;
      this.recompute(threadId);
      // Keep the steer queued. A later terminal event may drain it safely.
      throw err;
    }
    e.steerCancellationPending = false;
    this.activeRunThreads.delete(threadId);
    this.recompute(threadId);
    this.drainQueued(threadId);
    this.pumpRunQueue();
  }

  async stop(threadId: string): Promise<void> {
    const e = this.entries.get(threadId);
    if (!e) return;
    try {
      if (e.runId) {
        await e.client.runs.cancel(threadId, e.runId, true);
      } else {
        // Hydration can observe an active run without learning its run ID.
        await this.apiClient.stopRun(threadId);
      }
      await e.controller.stop({ cancel: false });
    } catch (error) {
      // Keep the loading state truthful when the server misses its cancellation
      // deadline; a later terminal event can still settle the controller.
      console.error(`[stream] failed to stop run for ${threadId}:`, error);
    }
    this.recompute(threadId);
  }

  async decide(
    threadId: string,
    interruptId: string,
    decision: HitlDecision,
    editedArgs?: unknown,
    editedName?: string,
    message?: string,
  ): Promise<void> {
    const e = this.entries.get(threadId);
    if (!e) return;
    const count = e.pendingInterruptCount ?? 1;
    // The middleware rejects a batch whose decision count does not match.
    const command = buildBatchResumeCommand(interruptId, decision, count, editedArgs, editedName, message);
    await e.controller.respond(command, { interruptId, namespace: [] });
  }

  openSubagentTranscript(threadId: string, delegationId: string): SubagentTranscriptHandle | null {
    const e = this.entries.get(threadId);
    if (!e) return null;
    const snap = e.controller.subagentStore.getSnapshot().get(delegationId);
    if (!snap) return null;
    const listeners = new Set<() => void>();
    let projection: {
      store: {
        subscribe: (listener: () => void) => () => void;
        getSnapshot: () => unknown;
      };
      release: () => void;
    } | undefined;
    let unsubscribeProjection: (() => void) | undefined;
    let released = false;
    // useSyncExternalStore requires stable snapshots between actual updates.
    let lastRaw: unknown;
    let lastFolded: UIMessageLike[] = [];
    const notify = () => {
      for (const listener of listeners) listener();
    };
    void e.controller.resolveSubagentNamespace(delegationId)
      .catch(() => {
        // Fall back to the latest known namespace when history lookup fails.
      })
      .then(() => {
        if (released || this.entries.get(threadId) !== e) return;
        const resolved = e.controller.subagentStore.getSnapshot().get(delegationId);
        if (!resolved) return;
        const acquired = e.controller.registry.acquire(messagesProjection(resolved.namespace));
        projection = acquired;
        unsubscribeProjection = acquired.store.subscribe(notify);
        notify();
      });
    return {
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getMessages: () => {
        const raw = projection?.store.getSnapshot();
        if (raw === undefined) return lastFolded;
        if (raw !== lastRaw) {
          lastRaw = raw;
          lastFolded = messagesToUI(raw as unknown as RawMessage[]);
        }
        return lastFolded;
      },
      release: () => {
        if (released) return;
        released = true;
        unsubscribeProjection?.();
        projection?.release();
        listeners.clear();
      },
    };
  }
}

function taskCallBatches(messages: RawMessage[]): Map<string, string> {
  const byCallId = new Map<string, string>();
  for (const m of messages) {
    const kw = (m as { kwargs?: RawMessage }).kwargs ?? m;
    const calls = m.tool_calls ?? kw.tool_calls ?? [];
    const rawId = m.id ?? kw.id;
    const msgId = Array.isArray(rawId) ? rawId.join("/") : rawId;
    if (!msgId || calls.length === 0) continue;
    for (const c of calls) {
      if (c.name === "task" && typeof c.id === "string") byCallId.set(c.id, msgId);
    }
  }
  return byCallId;
}

function taskCallErrors(messages: RawMessage[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const m of messages) {
    const kw = (m as { kwargs?: RawMessage }).kwargs ?? m;
    const callId = m.tool_call_id ?? kw.tool_call_id;
    const status = m.status ?? kw.status;
    if (typeof callId !== "string" || status !== "error") continue;
    const content = m.content ?? kw.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                part && typeof part === "object" && "text" in part
                  ? String(part.text ?? "")
                  : "",
              )
              .filter(Boolean)
              .join("\n")
          : "";
    errors.set(callId, text || "Delegated task failed.");
  }
  return errors;
}

function sliceEqual(a: ProtocolThreadSlice, b: ProtocolThreadSlice): boolean {
  // Projection folds allocate arrays, so compare their serialized content.
  return (
    a.status === b.status &&
    a.errorText === b.errorText &&
    a.errorCode === b.errorCode &&
    a.runId === b.runId &&
    a.attached === b.attached &&
    a.hydrationStatus === b.hydrationStatus &&
    a.hydrationError === b.hydrationError &&
    a.usage?.input === b.usage?.input &&
    a.usage?.output === b.usage?.output &&
    JSON.stringify(a.queued) === JSON.stringify(b.queued) &&
    JSON.stringify(a.messages) === JSON.stringify(b.messages) &&
    JSON.stringify(a.delegations) === JSON.stringify(b.delegations)
  );
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export const protocolStreamStore = new ProtocolStreamStore();
