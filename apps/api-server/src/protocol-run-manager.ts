import { classifyError, type RunInput, type RunOptions } from "@pizza-bot/core";
import type { RunStatus } from "@pizza-bot/core";
import type { ProtocolEvent } from "@langchain/langgraph";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { getLogger, withLogContext } from "@pizza-bot/logging";

type ReplayableProtocolEvent = ProtocolEvent & { event_id: string };

export type StreamProtocolFn = (
  input: RunInput,
  opts: RunOptions,
) => AsyncIterable<ProtocolEvent>;

export interface ProtocolFilter {
  channels: string[];
  namespaces?: string[][];
  depth?: number;
  since?: number;
}

export interface ProtocolRunHandle {
  runId: string;
  threadId: string;
}

export interface ProtocolRunEnd {
  threadId: string;
  runId: string;
  status: RunStatus;
  inputType: "messages" | "resume";
}

export interface ProtocolCancelResult {
  accepted: boolean;
  settled: boolean;
}

const DEFAULT_BUFFER_CAP = 4000;
const DEFAULT_EVICT_AFTER_MS = 60_000;
const DEFAULT_CANCEL_WAIT_MS = 10_000;

let runCounter = 0;
const newRunId = () => `run_${Date.now().toString(36)}_${runCounter++}`;

function inferChannel(ev: ProtocolEvent): string | undefined {
  switch (ev.method) {
    case "values":
    case "checkpoints":
    case "updates":
    case "messages":
    case "tools":
    case "lifecycle":
    case "tasks":
      return ev.method;
    case "input.requested":
      return "input";
    case "custom": {
      const data = ev.params.data as { name?: unknown } | undefined;
      return data?.name != null ? `custom:${data.name}` : "custom";
    }
    default:
      return undefined;
  }
}

function isPrefixMatch(ns: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > ns.length) return false;
  for (let i = 0; i < prefix.length; i++) if (ns[i] !== prefix[i]) return false;
  return true;
}

function namespaceMatches(
  ns: readonly string[],
  prefixes: string[][] | undefined,
  depth: number | undefined,
): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    if (!isPrefixMatch(ns, prefix)) return false;
    if (depth === undefined) return true;
    return ns.length - prefix.length <= depth;
  });
}

export function frameMatchesFilter(ev: ProtocolEvent, filter: ProtocolFilter): boolean {
  const channel = inferChannel(ev);
  if (channel === undefined) return false;
  const wanted = filter.channels;
  const channelOk =
    wanted.includes(channel) || (channel.startsWith("custom:") && wanted.includes("custom"));
  if (!channelOk) return false;
  return namespaceMatches(ev.params.namespace, filter.namespaces, filter.depth);
}

interface RunState {
  runId: string;
  threadId: string;
  inputType: ProtocolRunEnd["inputType"];
  abort: AbortController;
  buffer: ReplayableProtocolEvent[];
  // Absolute frame ordinals survive ring-buffer eviction; observers subtract
  // dropped to find the current array slot.
  dropped: number;
  cap: number;
  done: boolean;
  waiters: Set<() => void>;
  evictTimer?: ReturnType<typeof setTimeout>;
  discarded: boolean;
  settled: Promise<void>;
  settle: () => void;
}

export class ProtocolRunManager {
  private readonly log = getLogger("runs");
  private readonly runs = new Map<string, RunState>();
  private readonly activeRuns = new Set<RunState>();
  private readonly threadsBeingDeleted = new Set<string>();
  private readonly cap: number;
  private readonly evictAfterMs: number;
  private seqCounter = 0;
  private closing = false;

  constructor(
    private readonly streamFn: StreamProtocolFn,
    opts: { bufferCap?: number; evictAfterMs?: number } = {},
  ) {
    this.cap = opts.bufferCap ?? DEFAULT_BUFFER_CAP;
    this.evictAfterMs = opts.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
  }

  start(threadId: string, input: RunInput, opts?: Partial<RunOptions>): ProtocolRunHandle {
    if (this.closing) {
      throw new Error("Cannot start a run while the run manager is shutting down");
    }
    if (this.threadsBeingDeleted.has(threadId)) {
      throw new Error(`Cannot start a run while thread ${threadId} is being deleted`);
    }
    // A thread has one active graph run; a new start supersedes the previous run.
    const prior = this.runs.get(threadId);
    let priorSettled: Promise<void> | undefined;
    if (prior && !prior.done) {
      priorSettled = prior.settled;
      prior.abort.abort();
    }
    if (prior?.evictTimer) clearTimeout(prior.evictTimer);

    const runId = opts?.runId ?? newRunId();
    const abort = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const state: RunState = {
      runId,
      threadId,
      inputType: "command" in input ? "resume" : "messages",
      abort,
      buffer: [],
      dropped: 0,
      cap: this.cap,
      done: false,
      waiters: new Set(),
      discarded: false,
      settled,
      settle,
    };
    this.runs.set(threadId, state);
    this.activeRuns.add(state);
    this.log.info("Run started", {
      event: "run.started",
      threadId,
      runId,
      inputType: "command" in input ? "resume" : "messages",
      messageCount: "messages" in input ? input.messages.length : undefined,
    });
    const pump = () =>
      this.pump(state, input, {
        threadId,
        ...opts,
        runId,
        signal: abort.signal,
      });
    void withLogContext(
      { threadId, runId },
      () =>
        priorSettled
          ? priorSettled.then(() => {
              if (abort.signal.aborted) {
                this.finish(state, "cancelled");
                return;
              }
              return pump();
            })
          : pump(),
    );
    return { runId, threadId };
  }

  isRunning(threadId: string): boolean {
    const state = this.runs.get(threadId);
    return !!state && !state.done;
  }

  /** Resolves once every run that was active at the call boundary has settled. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.activeRuns].map((state) => state.settled));
  }

  /** Refuse new runs, abort every active run, then wait for them all to settle. */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const state of this.activeRuns) state.abort.abort();
    await this.whenIdle();
  }

  cancel(threadId: string, runId?: string): boolean {
    const state = this.runs.get(threadId);
    if (!state || state.done) return false;
    // A late REST cancel must not abort a newer run on the same thread.
    if (runId !== undefined && state.runId !== runId) return false;
    state.abort.abort();
    this.log.info("Run cancellation requested", {
      event: "run.cancel_requested",
      threadId,
      runId: state.runId,
    });
    return true;
  }

  async cancelAndWait(
    threadId: string,
    runId?: string,
    timeoutMs = DEFAULT_CANCEL_WAIT_MS,
  ): Promise<ProtocolCancelResult> {
    const state = this.runs.get(threadId);
    if (!state || state.done || (runId !== undefined && state.runId !== runId)) {
      return { accepted: false, settled: false };
    }
    state.abort.abort();
    return {
      accepted: true,
      settled: await settlesWithin(state.settled, timeoutMs),
    };
  }

  async discardThread(threadId: string): Promise<void> {
    const current = this.runs.get(threadId);
    const active = [...this.activeRuns].filter((state) => state.threadId === threadId);
    // Suppress lifecycle side effects before aborting, then wait until every
    // superseded generation has stopped writing checkpoints.
    for (const state of active) {
      state.discarded = true;
      state.abort.abort();
    }
    if (current?.evictTimer) clearTimeout(current.evictTimer);
    await Promise.all(active.map((state) => state.settled));
    if (this.runs.get(threadId) === current) this.runs.delete(threadId);
  }

  async beginThreadDeletion(threadId: string): Promise<() => void> {
    // The caller holds this fence through durable cleanup so no replacement run
    // can recreate state between draining and checkpoint deletion.
    this.threadsBeingDeleted.add(threadId);
    const parked = this.runWaiters.get(threadId);
    if (parked) {
      for (const wake of parked) wake();
      parked.clear();
    }
    try {
      await this.discardThread(threadId);
    } catch (error) {
      this.threadsBeingDeleted.delete(threadId);
      throw error;
    }
    return () => {
      this.threadsBeingDeleted.delete(threadId);
    };
  }

  // The SDK keeps one event stream open across turns and HITL resumes. Replay
  // buffered seq values, follow replacement runs, and end only on connection abort.
  async *observe(
    threadId: string,
    filter: ProtocolFilter,
    signal?: AbortSignal,
  ): AsyncIterable<ReplayableProtocolEvent> {
    let state = this.runs.get(threadId);
    while (!state) {
      if (signal?.aborted || this.threadsBeingDeleted.has(threadId)) return;
      await this.waitForRun(threadId, signal);
      state = this.runs.get(threadId);
    }

    // cursor is an absolute ordinal, not an index into the shifting ring buffer.
    let cursor = state.dropped;
    const since = filter.since;
    for (;;) {
      if (signal?.aborted || this.threadsBeingDeleted.has(threadId)) return;
      while (cursor < state.dropped + state.buffer.length) {
        if (signal?.aborted) return;
        if (cursor < state.dropped) cursor = state.dropped;
        const ev = state.buffer[cursor - state.dropped];
        cursor++;
        if (ev === undefined) continue;
        const seq = ev.seq ?? 0;
        if (since !== undefined && seq <= since) continue;
        if (frameMatchesFilter(ev, filter)) yield ev;
      }
      const current = this.runs.get(threadId);
      if (current && current !== state) {
        // seq is manager-global, so the same since filter remains valid.
        state = current;
        cursor = state.dropped;
        continue;
      }
      if (!state.done) {
        await this.waitOn(state.waiters, signal);
        continue;
      }
      // Terminal frames pause the SDK subscription; they do not close its stream.
      await this.waitForRun(threadId, signal);
      if (signal?.aborted) return;
      const next = this.runs.get(threadId);
      if (next && next !== state) {
        state = next;
        cursor = state.dropped;
      }
    }
  }

  private readonly endListeners = new Emitter<ProtocolRunEnd>(
    (err, v) => `[protocol-run-manager] end listener threw (thread=${v.threadId}): ${classifyError(err)}`,
  );
  onEnd(listener: (v: ProtocolRunEnd) => void): Unsubscribe {
    return this.endListeners.subscribe(listener);
  }

  private async pump(state: RunState, input: RunInput, opts: RunOptions): Promise<void> {
    let failed = false;
    let interrupted = false;
    let sawTerminalRoot = false;
    try {
      for await (const ev of this.streamFn(input, opts)) {
        if (opts.signal?.aborted) break;
        // A shared monotonic sequence keeps replay coherent across run boundaries.
        const stamped = this.stamp(ev, state.runId);
        if (isTerminalRootLifecycle(stamped)) {
          sawTerminalRoot = true;
          if (isInterruptedLifecycle(stamped)) interrupted = true;
        }
        this.append(state, stamped);
      }
    } catch (err) {
      if (!opts.signal?.aborted) {
        failed = true;
        this.log.error("Run failed", err, {
          event: "run.failed",
          threadId: state.threadId,
          runId: state.runId,
        });
        this.append(
          state,
          this.stamp(
            makeLifecycleFrame("failed", {
              error: err instanceof Error ? err.message : String(err),
              code: classifyError(err),
            }),
            state.runId,
          ),
        );
        sawTerminalRoot = true;
      }
    }
    // start() installs the replacement synchronously, distinguishing supersession
    // from an explicit cancel even though both abort the old signal.
    const superseded = this.runs.get(state.threadId) !== state;
    const { synthesize, status } = decideTerminal({
      aborted: opts.signal?.aborted === true,
      superseded,
      sawTerminalRoot,
      interrupted,
      failed,
    });
    if (synthesize === "cancelled") {
      // The protocol has no cancelled lifecycle; a requested stop is successful
      // for clients while the run registry retains the cancelled outcome.
      this.append(
        state,
        this.stamp(
          makeLifecycleFrame("completed", {
            code: "CANCELLED",
          }),
          state.runId,
        ),
      );
    } else if (synthesize === "completed") {
      this.append(
        state,
        this.stamp(
          makeLifecycleFrame("completed", {}),
          state.runId,
        ),
      );
    }
    this.finish(state, status);
  }

  private append(state: RunState, ev: ReplayableProtocolEvent): void {
    state.buffer.push(ev);
    if (state.buffer.length > state.cap) {
      state.buffer.shift();
      state.dropped++;
    }
    this.wake(state);
  }

  private finish(state: RunState, status: RunStatus): void {
    state.done = true;
    this.activeRuns.delete(state);
    this.wake(state);
    if (!state.discarded) {
      const end: ProtocolRunEnd = {
        threadId: state.threadId,
        runId: state.runId,
        status,
        inputType: state.inputType,
      };
      this.log.info("Run ended", {
        event: "run.ended",
        threadId: state.threadId,
        runId: state.runId,
        status,
      });
      this.endListeners.emit(end);
      state.evictTimer = setTimeout(() => {
        // Never let an old timer evict a replacement run.
        if (this.runs.get(state.threadId) === state) this.runs.delete(state.threadId);
      }, this.evictAfterMs);
      (state.evictTimer as { unref?: () => void }).unref?.();
    }
    state.settle();
  }

  private wake(state: RunState): void {
    for (const wake of state.waiters) wake();
    state.waiters.clear();
    const parked = this.runWaiters.get(state.threadId);
    if (parked) {
      for (const w of parked) w();
      parked.clear();
    }
  }

  private stamp(
    ev: ProtocolEvent,
    runId: string,
  ): ReplayableProtocolEvent {
    const seq = this.seqCounter++;
    return { ...ev, seq, event_id: `${runId}:${seq}` };
  }

  private waitOn(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        // Normal wakeups must detach the abort listener; once only helps on abort.
        waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      // An abort landing between the caller's signal.aborted check and this
      // listener never fires the event again, so re-check to avoid parking forever.
      if (signal?.aborted) done();
    });
  }

  private readonly runWaiters = new Map<string, Set<() => void>>();
  private async waitForRun(threadId: string, signal?: AbortSignal): Promise<void> {
    let set = this.runWaiters.get(threadId);
    if (!set) {
      set = new Set();
      this.runWaiters.set(threadId, set);
    }
    await this.waitOn(set, signal);
    if (set.size === 0 && this.runWaiters.get(threadId) === set) {
      this.runWaiters.delete(threadId);
    }
  }
}

async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`cancel timeout must be a non-negative finite number, got ${timeoutMs}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function decideTerminal(input: {
  aborted: boolean;
  superseded: boolean;
  sawTerminalRoot: boolean;
  interrupted: boolean;
  failed: boolean;
}): { synthesize: "cancelled" | "completed" | null; status: RunStatus } {
  const { aborted, superseded, sawTerminalRoot, interrupted, failed } = input;
  if (aborted) {
    // A superseded run emits no terminal frame because it shares the stream with
    // its replacement; a terminal here would clear the replacement's loading state.
    return { synthesize: superseded ? null : "cancelled", status: "cancelled" };
  }
  const synthesize = sawTerminalRoot ? null : "completed";
  const status: RunStatus = interrupted ? "interrupted" : failed ? "error" : "success";
  return { synthesize, status };
}

function isTerminalRootLifecycle(ev: ProtocolEvent): boolean {
  if (ev.method !== "lifecycle") return false;
  if (ev.params.namespace.length !== 0) return false;
  const data = ev.params.data as { event?: string } | undefined;
  return data?.event === "completed" || data?.event === "failed" || data?.event === "interrupted";
}

function isInterruptedLifecycle(ev: ProtocolEvent): boolean {
  const data = ev.params.data as { event?: string } | undefined;
  return data?.event === "interrupted";
}

function makeLifecycleFrame(event: "completed" | "failed", extra: Record<string, unknown>): ProtocolEvent {
  return {
    type: "event",
    seq: 0,
    method: "lifecycle",
    params: {
      namespace: [],
      timestamp: 0,
      data: { event, graph_name: "root", ...extra },
    },
  } as ProtocolEvent;
}
