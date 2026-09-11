import { toRunInput } from "./input.js";
import type { RunOptions, ThreadState } from "@pizza-bot/core";
import type { ProtocolRunManager } from "./protocol-run-manager.js";

export interface ProtocolCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface StateReader {
  getState(threadId: string): Promise<ThreadState>;
}

export type ProtocolCommandOutcome =
  | { kind: "success"; id: number; result: Record<string, unknown> }
  | { kind: "no_content" }
  | { kind: "cancellation_pending"; id: number }
  | { kind: "unsupported"; method: string };

export class ProtocolCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolCommandError";
  }
}

export async function dispatchProtocolCommand(opts: {
  runs: ProtocolRunManager;
  stateReader: StateReader;
  threadId: string;
  command: ProtocolCommand;
}): Promise<ProtocolCommandOutcome> {
  const { runs, stateReader, threadId, command } = opts;
  assertThreadAuthority(command.params, threadId);

  switch (command.method) {
    case "run.start": {
      const handle = runs.start(
        threadId,
        runStartInput(command.params),
        runOptsFromCommand(command.params),
      );
      return { kind: "success", id: command.id, result: { run_id: handle.runId } };
    }
    case "input.respond": {
      const handle = runs.start(
        threadId,
        inputRespondInput(command.params),
        runOptsFromCommand(command.params),
      );
      return { kind: "success", id: command.id, result: { run_id: handle.runId } };
    }
    case "run.stop": {
      const result = await runs.cancelAndWait(threadId);
      return result.accepted && !result.settled
        ? { kind: "cancellation_pending", id: command.id }
        : { kind: "no_content" };
    }
    case "state.get": {
      const state = await stateReader.getState(threadId);
      return {
        kind: "success",
        id: command.id,
        result: toProtocolState(state),
      };
    }
    default:
      return { kind: "unsupported", method: String(command.method) };
  }
}

export function assertThreadAuthority(
  params: Record<string, unknown> | undefined,
  threadId: string,
): void {
  const cfg = (params?.config as { configurable?: { thread_id?: unknown } } | undefined)?.configurable;
  const configuredThreadId = cfg?.thread_id;
  if (configuredThreadId !== undefined && configuredThreadId !== threadId) {
    throw new ProtocolCommandError(
      "thread_id_mismatch",
      `configurable.thread_id must match URL thread ${threadId}`,
    );
  }
}

export function runOptsFromCommand(params: Record<string, unknown> | undefined): Partial<RunOptions> {
  const configurable = (params?.config as { configurable?: Record<string, unknown> } | undefined)?.configurable;
  if (!configurable) return {};
  const { thread_id: _threadId, ...rest } = configurable;
  return Object.keys(rest).length > 0 ? { configurable: rest } : {};
}

export function runStartInput(params: Record<string, unknown> | undefined) {
  return toRunInput({ input: params?.input, ...params });
}

export function inputRespondInput(params: Record<string, unknown> | undefined) {
  // SDK respond() places the resume command in response; bare commands remain supported.
  const resume = (params?.response ?? params) as Record<string, unknown>;
  return toRunInput({ command: resume });
}

function serializedMessageType(message: Record<string, unknown>): string | undefined {
  const getType = message.getType;
  if (typeof getType === "function") {
    try {
      const type = getType.call(message);
      if (typeof type === "string") return type;
    } catch {
      // Fall through to serialized constructor metadata.
    }
  }
  if (["human", "ai", "tool", "system", "function"].includes(String(message.type))) {
    return String(message.type);
  }
  const id = message.id;
  const constructorName = Array.isArray(id) ? id.at(-1) : undefined;
  return constructorName === "HumanMessage"
    ? "human"
    : constructorName === "AIMessage" || constructorName === "AIMessageChunk"
      ? "ai"
      : constructorName === "ToolMessage"
        ? "tool"
        : constructorName === "SystemMessage"
          ? "system"
          : constructorName === "FunctionMessage"
            ? "function"
            : undefined;
}

function toProtocolMessage(message: unknown): unknown {
  if (message == null || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  const kwargs =
    record.kwargs != null && typeof record.kwargs === "object"
      ? record.kwargs as Record<string, unknown>
      : undefined;
  const type = serializedMessageType(record);
  if (!type) return message;
  const fields = Object.fromEntries(
    Object.entries(kwargs ?? record).filter(([key, value]) =>
      !key.startsWith("lc_") && key !== "getType" && typeof value !== "function",
    ),
  );
  return {
    ...fields,
    type,
  };
}

function toProtocolValues(values: ThreadState["values"]): ThreadState["values"] {
  return Array.isArray(values.messages)
    ? {
        ...values,
        messages: values.messages.map(toProtocolMessage) as NonNullable<
          ThreadState["values"]["messages"]
        >,
      }
    : values;
}

function toProtocolTaskResult(result: unknown): unknown {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  return Array.isArray(record.messages)
    ? { ...record, messages: record.messages.map(toProtocolMessage) }
    : result;
}

export function toProtocolState(s: ThreadState): Record<string, unknown> {
  const interrupts = s.interrupts ?? [];
  const checkpoint = {
    thread_id: s.threadId,
    checkpoint_ns: s.checkpointNs ?? "",
    checkpoint_id: s.checkpointId || null,
    checkpoint_map: s.checkpointMap ?? null,
  };
  const tasks = s.tasks?.map((task) => ({
    id: task.id,
    name: task.name,
    ...(task.path ? { path: task.path } : {}),
    ...(task.result !== undefined ? { result: toProtocolTaskResult(task.result) } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    interrupts: task.interrupts.map((interrupt) => ({
      id: interrupt.id,
      value: interrupt.value,
    })),
    checkpoint: task.checkpoint
      ? {
          thread_id: task.checkpoint.threadId,
          checkpoint_ns: task.checkpoint.checkpointNs,
          checkpoint_id: task.checkpoint.checkpointId ?? null,
          checkpoint_map: task.checkpoint.checkpointMap ?? null,
        }
      : null,
  }));
  return {
    values: toProtocolValues(s.values),
    next: s.next,
    checkpoint,
    metadata: s.metadata ?? {},
    parent_checkpoint: s.parentCheckpoint
      ? {
          thread_id: s.parentCheckpoint.threadId,
          checkpoint_ns: s.parentCheckpoint.checkpointNs,
          checkpoint_id: s.parentCheckpoint.checkpointId ?? null,
          checkpoint_map: s.parentCheckpoint.checkpointMap ?? null,
        }
      : null,
    checkpoint_id: s.checkpointId,
    thread_id: s.threadId,
    created_at: s.createdAt,
    ...(s.awaitingInput !== undefined ? { awaiting_input: s.awaitingInput } : {}),
    // An explicit empty list clears approvals resolved outside this client.
    tasks:
      tasks ??
      (interrupts.length > 0
        ? [{ interrupts: interrupts.map((i) => ({ id: i.id, value: i.value })) }]
        : []),
  };
}
