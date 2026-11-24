/** State reads and protocol streaming shared by every compiled graph a thread can run. */
import type { ProtocolEvent, StateSnapshot } from "@langchain/langgraph";
import type {
  AgentHandle,
  Checkpoint,
  RunInput,
  RunOptions,
  StateHistoryOptions,
  ThreadCheckpoint,
  ThreadState,
  ThreadStateValues,
  ThreadTask,
} from "@pizza-bot/core";
import { streamProtocolEvents, toLangGraphInput, type ProtocolCapableGraph } from "./stream-protocol.js";

export interface CompiledGraph extends ProtocolCapableGraph {
  invoke(input: unknown, config?: unknown): Promise<unknown>;
  stream(
    input: unknown,
    config: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
  getState(config: Record<string, unknown>): Promise<StateSnapshot>;
  getStateHistory(
    config: Record<string, unknown>,
    options?: { limit?: number; before?: { configurable?: { checkpoint_id?: string } } },
  ): AsyncIterable<StateSnapshot>;
  updateState(
    config: Record<string, unknown>,
    values: unknown,
    asNode?: string,
  ): Promise<{ configurable?: { checkpoint_id?: string } }>;
}

type RuntimeTask = StateSnapshot["tasks"][number];

/**
 * Detect HITL from checkpoint task interrupts. `next` also covers non-HITL
 * pauses, while task interrupts remain authoritative across reloads.
 */
function snapshotAwaitingInput(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<unknown> }>;
}): boolean {
  return (snap.tasks ?? []).some((t) => (t.interrupts?.length ?? 0) > 0);
}

/** Preserve durable HITL payloads so the SDK can rebuild approval state. */
function snapshotInterrupts(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: unknown; value?: unknown }> }>;
}): Array<{ id: string; value: unknown }> {
  const out: Array<{ id: string; value: unknown }> = [];
  for (const task of snap.tasks ?? []) {
    for (const it of task.interrupts ?? []) {
      if (typeof it?.id === "string") out.push({ id: it.id, value: it.value });
    }
  }
  return out;
}

function checkpointFromConfig(config: unknown): ThreadCheckpoint | undefined {
  if (config == null || typeof config !== "object") return undefined;
  const configurable = (config as {
    configurable?: {
      thread_id?: unknown;
      checkpoint_id?: unknown;
      checkpoint_ns?: unknown;
      checkpoint_map?: unknown;
    };
  }).configurable;
  if (configurable == null || typeof configurable !== "object") return undefined;
  const threadId = configurable.thread_id;
  if (typeof threadId !== "string") return undefined;
  const checkpointId = configurable.checkpoint_id;
  const checkpointNs = configurable.checkpoint_ns;
  const checkpointMap = configurable.checkpoint_map;
  return {
    threadId,
    checkpointNs: typeof checkpointNs === "string" ? checkpointNs : "",
    ...(typeof checkpointId === "string" ? { checkpointId } : {}),
    ...(checkpointMap != null && typeof checkpointMap === "object"
      ? { checkpointMap: checkpointMap as Record<string, unknown> }
      : {}),
  };
}

function taskCheckpoint(state: unknown): ThreadCheckpoint | undefined {
  if (state == null || typeof state !== "object") return undefined;
  const nestedConfig = (state as { config?: unknown }).config;
  return checkpointFromConfig(nestedConfig ?? state);
}

function snapshotTasks(snap: { tasks?: ReadonlyArray<RuntimeTask> }): ThreadTask[] {
  return (snap.tasks ?? []).map((task) => {
    const checkpoint = taskCheckpoint(task.state);
    return {
      id: task.id,
      name: task.name,
      ...(task.path ? { path: [...task.path] } : {}),
      ...(task.result !== undefined ? { result: task.result } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      interrupts: (task.interrupts ?? []).flatMap((interrupt) =>
        typeof interrupt.id === "string"
          ? [{ id: interrupt.id, value: interrupt.value }]
          : [],
      ),
      ...(checkpoint ? { checkpoint } : {}),
    };
  });
}

export class LangGraphThreadGraph implements AgentHandle {
  constructor(protected readonly compiled: CompiledGraph) {}

  async *streamProtocol(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> {
    const config = { configurable: { thread_id: opts.threadId } };
    if ("command" in input && !("response" in input.command)) {
      const snap = await this.compiled.getState(config);
      const pending = (snap.tasks ?? []).flatMap((task) => task.interrupts ?? []);
      const target = pending.find((it) => it.id === input.command.interruptId);
      // An approval decision is not an answer; the human node would store it as one.
      if ((target?.value as { type?: unknown } | undefined)?.type === "graph.human") {
        throw new Error("A graph human step takes a response, not an approval decision.");
      }
    }
    const continuing =
      "graphInput" in input &&
      input.continueFromCheckpoint === true &&
      Boolean((await this.compiled.getState(config)).config?.configurable?.checkpoint_id);
    yield* streamProtocolEvents(this.compiled, continuing ? null : toLangGraphInput(input), opts);
  }

  async getState(threadId: string, checkpointId?: string): Promise<ThreadState> {
    const config = {
      configurable: {
        thread_id: threadId,
        ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      },
    };
    const snap = await this.compiled.getState(config);
    const checkpoint = checkpointFromConfig(snap.config);
    const parentCheckpoint = checkpointFromConfig(snap.parentConfig);
    return {
      threadId,
      checkpointId: snap.config.configurable?.checkpoint_id ?? "",
      checkpointNs: checkpoint?.checkpointNs ?? "",
      ...(checkpoint?.checkpointMap ? { checkpointMap: checkpoint.checkpointMap } : {}),
      values: (snap.values ?? {}) as ThreadStateValues,
      next: snap.next,
      createdAt: snap.createdAt ?? "",
      metadata: snap.metadata ?? {},
      ...(parentCheckpoint ? { parentCheckpoint } : {}),
      tasks: snapshotTasks(snap),
      awaitingInput: snapshotAwaitingInput(snap),
      interrupts: snapshotInterrupts(snap),
    };
  }

  async *getStateHistory(
    threadId: string,
    options?: StateHistoryOptions,
  ): AsyncIterable<ThreadState> {
    const checkpointNs = options?.checkpointNs;
    const config = {
      configurable: { thread_id: threadId, ...(checkpointNs ? { checkpoint_ns: checkpointNs } : {}) },
    };
    // The checkpointer only appends SQL LIMIT when it receives one; without it
    // the saver materializes every row for the thread and namespace at once.
    const listOptions = {
      ...(options?.limit != null ? { limit: options.limit } : {}),
      ...(options?.beforeCheckpointId != null
        ? { before: { configurable: { checkpoint_id: options.beforeCheckpointId } } }
        : {}),
    };
    for await (const snap of this.compiled.getStateHistory(config, listOptions)) {
      const checkpoint = checkpointFromConfig(snap.config);
      const parentCheckpoint = checkpointFromConfig(snap.parentConfig);
      yield {
        threadId,
        checkpointId: snap.config.configurable?.checkpoint_id ?? "",
        checkpointNs: checkpoint?.checkpointNs ?? checkpointNs ?? "",
        ...(checkpoint?.checkpointMap ? { checkpointMap: checkpoint.checkpointMap } : {}),
        values: (snap.values ?? {}) as ThreadStateValues,
        next: snap.next,
        createdAt: snap.createdAt ?? "",
        metadata: snap.metadata ?? {},
        ...(parentCheckpoint ? { parentCheckpoint } : {}),
        tasks: snapshotTasks(snap),
        awaitingInput: snapshotAwaitingInput(snap),
        interrupts: snapshotInterrupts(snap),
      };
    }
  }

  async updateState(threadId: string, values: unknown, asNode?: string): Promise<Checkpoint> {
    const config = { configurable: { thread_id: threadId } };
    const next = await this.compiled.updateState(config, values, asNode);
    return { checkpointId: next.configurable?.checkpoint_id ?? "", threadId };
  }
}


export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}
