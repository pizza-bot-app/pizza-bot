import { describe, it, expect, afterEach } from "vitest";
import type { ProtocolEvent } from "@langchain/langgraph";
import { streamProtocolEvents, type ProtocolCapableGraph } from "./stream-protocol.js";
import type { RunOptions } from "@pizza-bot/core";

const COMPLETED: ProtocolEvent = {
  type: "event",
  seq: 1,
  method: "lifecycle",
  params: { namespace: [], timestamp: 0, data: { event: "completed", graph_name: "root" } },
} as ProtocolEvent;

function fakeGraph(): ProtocolCapableGraph {
  return {
    async streamEvents() {
      const rejected = Promise.reject(new Error("Model X does not currently support 'tool_choice'."));
      return {
        interrupted: false,
        interrupts: [],
        toolCalls: {
          async *[Symbol.asyncIterator]() {
            yield { output: rejected };
          },
        },
        async *[Symbol.asyncIterator]() {
          yield COMPLETED;
        },
      };
    },
  };
}

function blockFrame(
  event: "content-block-start" | "content-block-delta" | "content-block-finish",
  index: number,
  extra: Record<string, unknown> = {},
): ProtocolEvent {
  return {
    type: "event",
    seq: 0,
    method: "messages",
    params: {
      namespace: ["model_request:abc"],
      node: "model_request",
      timestamp: 0,
      data: { event, index, ...extra },
    },
  } as ProtocolEvent;
}

function fakeGraphYielding(frames: ProtocolEvent[]): ProtocolCapableGraph {
  return {
    async streamEvents() {
      return {
        interrupted: false,
        interrupts: [],
        async *[Symbol.asyncIterator]() {
          for (const f of frames) yield f;
        },
      };
    },
  };
}

describe("streamProtocolEvents — content-block reindex", () => {
  it("densifies a Bedrock message whose text block starts at raw index 1", async () => {
    // Bedrock omits a signature-only block at index 0; the SDK requires dense indices.
    const frames = [
      blockFrame("content-block-start", 1, { content: { type: "text", text: "" } }),
      blockFrame("content-block-delta", 1, { delta: { type: "text-delta", text: "Hi" } }),
      blockFrame("content-block-finish", 1, { content: { type: "text", text: "Hi" } }),
      COMPLETED,
    ];
    const out: ProtocolEvent[] = [];
    for await (const ev of streamProtocolEvents(fakeGraphYielding(frames), { messages: [] }, { threadId: "t" })) {
      out.push(ev);
    }
    const indices = out
      .filter((e) => e.method === "messages")
      .map((e) => (e.params as { data?: { index?: number } }).data?.index);
    expect(indices).toEqual([0, 0, 0]);
  });

  it("preserves relative order for a multi-block message (1,2 → 0,1)", async () => {
    const frames = [
      blockFrame("content-block-start", 1, { content: { type: "text", text: "" } }),
      blockFrame("content-block-delta", 1, { delta: { type: "text-delta", text: "a" } }),
      blockFrame("content-block-start", 2, { content: { type: "tool_call", id: "x" } }),
      COMPLETED,
    ];
    const out: ProtocolEvent[] = [];
    for await (const ev of streamProtocolEvents(fakeGraphYielding(frames), { messages: [] }, { threadId: "t" })) {
      out.push(ev);
    }
    const indices = out
      .filter((e) => e.method === "messages")
      .map((e) => (e.params as { data?: { index?: number } }).data?.index);
    expect(indices).toEqual([0, 0, 1]);
  });

  it("resets the per-node map on message-start so a second message renumbers from 0", async () => {
    const startFrame: ProtocolEvent = {
      type: "event",
      seq: 0,
      method: "messages",
      params: { namespace: ["model_request:abc"], node: "model_request", timestamp: 0, data: { event: "message-start" } },
    } as ProtocolEvent;
    const frames = [
      blockFrame("content-block-start", 1, { content: { type: "text", text: "" } }),
      blockFrame("content-block-delta", 1, { delta: { type: "text-delta", text: "one" } }),
      startFrame,
      blockFrame("content-block-start", 1, { content: { type: "text", text: "" } }),
      blockFrame("content-block-delta", 1, { delta: { type: "text-delta", text: "two" } }),
      COMPLETED,
    ];
    const out: ProtocolEvent[] = [];
    for await (const ev of streamProtocolEvents(fakeGraphYielding(frames), { messages: [] }, { threadId: "t" })) {
      out.push(ev);
    }
    const indices = out
      .filter(
        (e) => e.method === "messages" && typeof (e.params as { data?: { index?: number } }).data?.index === "number",
      )
      .map((e) => (e.params as { data?: { index?: number } }).data?.index);
    expect(indices).toEqual([0, 0, 0, 0]);
  });

  it("leaves an already-dense message (raw index 0) untouched by identity", async () => {
    const start = blockFrame("content-block-start", 0, { content: { type: "text", text: "" } });
    const out: ProtocolEvent[] = [];
    for await (const ev of streamProtocolEvents(fakeGraphYielding([start, COMPLETED]), { messages: [] }, { threadId: "t" })) {
      out.push(ev);
    }
    expect(out[0]).toBe(start);
  });
});

describe("streamProtocolEvents — tool-call rejection drain", () => {
  const seen: unknown[] = [];
  const onReject = (reason: unknown) => seen.push(reason);
  afterEach(() => {
    process.off("unhandledRejection", onReject);
    seen.length = 0;
  });

  it("drains a rejecting toolCalls.output without an unhandled rejection", async () => {
    process.on("unhandledRejection", onReject);
    const opts: RunOptions = { threadId: "t1" };
    const frames: ProtocolEvent[] = [];
    for await (const ev of streamProtocolEvents(fakeGraph(), { messages: [] }, opts)) {
      frames.push(ev);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]?.method).toBe("lifecycle");
    // Allow Node to report any unhandled rejection.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(0);
  });
});
