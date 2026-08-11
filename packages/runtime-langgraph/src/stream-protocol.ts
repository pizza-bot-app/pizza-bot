/** Streams unencoded LangGraph v3 ProtocolEvents for the SDK transport. */
import { Command, type ProtocolEvent } from "@langchain/langgraph";
import type { RunInput, RunOptions, ResumeCommand, MessagePart } from "@pizza-bot/core";

/** Map a message turn or HITL resume to LangGraph input. */
export function toLangGraphInput(input: RunInput): { messages: unknown[] } | Command {
  if ("command" in input) {
    return new Command({ resume: toResumePayload(input.command) });
  }
  return {
    messages: input.messages.map((m) => ({ role: m.role, content: toContent(m.parts) })),
  };
}

/**
 * Keep attachment references in checkpointed messages. The model-call middleware
 * resolves them to base64 blocks without persisting the bytes.
 */
function toContent(parts: MessagePart[]): string | Array<Record<string, unknown>> {
  if (!parts.some((p) => p.type === "file")) {
    return parts.map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : "")).join("");
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    if ((p.type === "text" || p.type === "reasoning") && p.text.length > 0) {
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "file") {
      blocks.push({
        type: "file",
        url: p.url,
        mimeType: p.mediaType,
        ...(p.name ? { name: p.name } : {}),
      });
    }
  }
  return blocks;
}

function toResumePayload(cmd: ResumeCommand): { decisions: unknown[] } {
  return {
    decisions: cmd.decisions.map((d) => {
      switch (d.decision) {
        case "edit":
          // HITL requires the edited action to retain the interrupted tool name.
          return { type: "edit", editedAction: { name: d.editedName, args: d.editedArgs } };
        case "reject":
          return { type: "reject", message: d.message };
        case "respond":
          return { type: "respond", message: d.message };
        case "approve":
        default:
          return { type: "approve" };
      }
    }),
  };
}

/** V3 stream shape, including its authoritative HITL state. */
interface GraphRunLike extends AsyncIterable<ProtocolEvent> {
  readonly interrupted: boolean;
  readonly interrupts: ReadonlyArray<{ readonly interruptId: string; readonly payload: unknown }>;
  // The raw-frame consumer must handle these projections' rejected promises.
  readonly toolCalls?: AsyncIterable<ToolCallLike>;
  readonly subagents?: AsyncIterable<SubagentRunLike>;
}

interface ToolCallLike {
  readonly output?: Promise<unknown>;
}

interface SubagentRunLike {
  readonly output?: Promise<unknown>;
  readonly toolCalls?: AsyncIterable<ToolCallLike>;
  readonly subagents?: AsyncIterable<SubagentRunLike>;
}

export interface ProtocolCapableGraph {
  streamEvents(
    input: unknown,
    options: {
      version: "v3";
      configurable?: Record<string, unknown>;
      signal?: AbortSignal;
      [k: string]: unknown;
    },
  ): Promise<GraphRunLike>;
}

/**
 * Pump native frames and synthesize HITL protocol signals after the stream drains.
 * DeepAgents exposes `__interrupt__` through stream getters but emits neither
 * `input.requested` nor terminal `interrupted`; both are required to preserve the
 * approval card and prevent maintenance from advancing the paused checkpoint.
 */
export async function* streamProtocolEvents(
  graph: ProtocolCapableGraph,
  input: { messages: unknown[]; files?: unknown } | object,
  opts: RunOptions,
): AsyncIterable<ProtocolEvent> {
  const options = {
    version: "v3" as const,
    configurable: { thread_id: opts.threadId, ...opts.configurable },
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const stream = await graph.streamEvents(input, options);
  // Attach rejection handlers before iteration so tool errors remain in-band.
  drainProjectionRejections(stream);
  const reindexer = new ContentBlockReindexer();
  for await (const event of stream) {
    yield reindexer.process(event);
  }
  // Cancellation takes precedence over an interrupt observed during teardown.
  if (opts.signal?.aborted) return;
  if (stream.interrupted) {
    // The manager replaces placeholder sequence numbers with its monotonic index.
    for (const it of stream.interrupts) {
      yield inputRequestedFrame(it.interruptId, it.payload);
    }
    yield interruptedLifecycleFrame();
  }
}

/**
 * LangChain's tool-call transformer rejects an unconsumed `output` promise for
 * each `tool-error`, including errors inside nested subagent projections. Node
 * treats those as unhandled even though the errors also arrive in-band. Drain
 * the optional projections until upstream removes this parallel rejection
 * channel; revalidate on LangChain upgrades.
 */
function drainProjectionRejections(run: SubagentRunLike): void {
  void run.output?.catch(() => {});
  if (run.toolCalls) {
    void drainToolCalls(run.toolCalls);
  }
  if (run.subagents) {
    void drainSubagents(run.subagents);
  }
}

async function drainToolCalls(toolCalls: AsyncIterable<ToolCallLike>): Promise<void> {
  try {
    for await (const call of toolCalls) {
      void call.output?.catch(() => {});
    }
  } catch {
    // Run failures are authoritative on the protocol lifecycle channel.
  }
}

async function drainSubagents(subagents: AsyncIterable<SubagentRunLike>): Promise<void> {
  try {
    for await (const subagent of subagents) {
      drainProjectionRejections(subagent);
    }
  } catch {
    // Run failures are authoritative on the protocol lifecycle channel.
  }
}

/**
 * Bedrock adaptive thinking can omit a signature-only block at raw index 0, while
 * @langchain/langgraph-sdk@1.9.25 expects dense indices and crashes on the hole.
 * Reindex by `namespace::node` and reset at both message boundaries. Remove only
 * after the SDK accepts sparse block arrays or Bedrock emits the omitted block.
 */
class ContentBlockReindexer {
  private readonly maps = new Map<string, Map<number, number>>();

  process(event: ProtocolEvent): ProtocolEvent {
    if (event.method !== "messages") return event;
    const params = event.params as {
      namespace?: readonly string[];
      node?: string;
      data?: Record<string, unknown>;
    };
    const data = params.data;
    const evt = data?.["event"];
    if (typeof evt !== "string") return event;

    const key = `${(params.namespace ?? []).join("/")}::${params.node ?? ""}`;

    // Reset on open too, in case the previous message ended without a close frame.
    if (evt === "message-start" || evt === "message-finish" || evt === "error") {
      this.maps.delete(key);
      return event;
    }
    if (evt !== "content-block-start" && evt !== "content-block-delta" && evt !== "content-block-finish") {
      return event;
    }
    const rawIndex = data?.["index"];
    if (typeof rawIndex !== "number") return event;

    let map = this.maps.get(key);
    if (!map) {
      map = new Map();
      this.maps.set(key, map);
    }
    let dense = map.get(rawIndex);
    if (dense === undefined) {
      dense = map.size;
      map.set(rawIndex, dense);
    }
    if (dense === rawIndex) return event;

    return {
      ...event,
      params: { ...params, data: { ...data, index: dense } },
    } as ProtocolEvent;
  }
}

function inputRequestedFrame(interruptId: string, payload: unknown): ProtocolEvent {
  return {
    type: "event",
    seq: 0,
    method: "input.requested",
    params: { namespace: [], timestamp: 0, data: { interrupt_id: interruptId, payload } },
  } as ProtocolEvent;
}

function interruptedLifecycleFrame(): ProtocolEvent {
  return {
    type: "event",
    seq: 0,
    method: "lifecycle",
    params: { namespace: [], timestamp: 0, data: { event: "interrupted", graph_name: "root" } },
  } as ProtocolEvent;
}

export type { RunInput, RunOptions };
