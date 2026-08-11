import { describe, it, expect } from "vitest";
import type { ProtocolEvent } from "@langchain/langgraph";
import { ASSISTANT_ID, type RunInput, type RunOptions, type ThreadState } from "@pizza-bot/core";
import { streamProtocolEvents, type ProtocolCapableGraph } from "@pizza-bot/runtime-langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { StreamController } from "@langchain/langgraph-sdk/stream";
import { ProtocolRunManager } from "./protocol-run-manager.js";
import { InProcessTransport } from "./test-utils/in-process-transport.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};

function blockFrame(
  event: "message-start" | "content-block-start" | "content-block-delta" | "content-block-finish" | "message-finish",
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
      data: { event, ...extra },
    },
  } as ProtocolEvent;
}

function bedrockShapedGraph(): ProtocolCapableGraph {
  const frames: ProtocolEvent[] = [
    blockFrame("message-start", { id: "msg_1", role: "ai" }),
    blockFrame("content-block-start", { index: 1, content: { type: "text", text: "" } }),
    blockFrame("content-block-delta", { index: 1, delta: { type: "text-delta", text: "Hello" } }),
    blockFrame("content-block-delta", { index: 1, delta: { type: "text-delta", text: " world" } }),
    blockFrame("content-block-finish", { index: 1, content: { type: "text", text: "Hello world" } }),
    blockFrame("message-finish", { id: "msg_1" }),
  ];
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

const fakeAgent = {
  getState: async (threadId: string): Promise<ThreadState> => ({
    threadId,
    checkpointId: "ckpt_1",
    values: { messages: [] },
    next: [],
    createdAt: "2026-01-01T00:00:00Z",
  }),
};

describe("streamed turn renders live through the real SDK assembler", () => {
  it("commits Bedrock index-1-first text to rootStore.messages (no reload)", async () => {
    const streamFn = (input: RunInput, opts: RunOptions) => streamProtocolEvents(bedrockShapedGraph(), input, opts);
    const runs = new ProtocolRunManager(streamFn);
    const threadId = "t-reindex";

    const client = new Client({ apiUrl: "http://in-process.invalid" });
    const controller = new StreamController({
      assistantId: ASSISTANT_ID,
      client,
      threadId,
      transport: new InProcessTransport(runs, fakeAgent, threadId).asAgentServerAdapter(),
      optimistic: false,
    });
    const release = controller.activate();
    try {
      await controller.submit({ messages: [{ role: "user", content: "hi" }] });
      await settle();

      const snapshot = controller.rootStore.getSnapshot();
      const assistant = snapshot.messages.find((m) => {
        const type = (m as { getType?: () => string }).getType?.();
        return type === "ai";
      });
      expect(assistant, "an assistant message should be committed to rootStore").toBeDefined();
      const content = (assistant as { content?: unknown }).content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((b) => (b != null && typeof b === "object" && "text" in b ? (b as { text?: string }).text ?? "" : ""))
                .join("")
            : "";
      expect(text).toBe("Hello world");
    } finally {
      release();
    }
  });
});
