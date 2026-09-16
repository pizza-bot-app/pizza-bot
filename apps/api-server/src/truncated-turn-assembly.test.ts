import { describe, it, expect } from "vitest";
import { ASSISTANT_ID, PIZZA_BOT_AGENT, type RunInput, type RunOptions, type ThreadState } from "@pizza-bot/core";
import { createPizzaBotAgent } from "@pizza-bot/runtime-langgraph";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { Client } from "@langchain/langgraph-sdk";
import { StreamController } from "@langchain/langgraph-sdk/stream";
import { ProtocolRunManager } from "./protocol-run-manager.js";
import { InProcessTransport } from "./test-utils/in-process-transport.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await flush();
};

interface ScriptedTurn {
  events: ChatModelStreamEvent[];
  message: AIMessage;
}

/**
 * Streams native v3 events the way a real provider does (Bedrock's
 * `@langchain/aws` maps `stopReason: max_tokens` to `reason: "length"`), so
 * the assembled AIMessage carries `response_metadata.finish_reason` — the
 * signal the issue reports. The compat bridge for non-streaming models
 * hardcodes `reason: "stop"`, so a plain `_generate` script cannot exercise
 * this path.
 */
class NativeStreamModel extends BaseChatModel<Record<string, never>> {
  private i = 0;
  constructor(private readonly script: ScriptedTurn[]) {
    super({});
  }
  _llmType(): string {
    return "scripted-native-v3";
  }
  override bindTools(): this {
    return this;
  }
  private next(): ScriptedTurn {
    const turn = this.script[Math.min(this.i, this.script.length - 1)]!;
    this.i++;
    return turn;
  }
  async _generate(): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    return { generations: [{ message: this.next().message, text: "" }] };
  }
  override async *_streamChatModelEvents(): AsyncGenerator<ChatModelStreamEvent> {
    for (const event of this.next().events) yield event;
  }
}

function reasoningOnlyTruncatedTurn(): ScriptedTurn {
  return {
    events: [
      { event: "message-start" },
      { event: "content-block-start", index: 0, content: { type: "reasoning", reasoning: "" } },
      { event: "content-block-delta", index: 0, delta: { type: "reasoning-delta", reasoning: "thinking" } },
      { event: "content-block-finish", index: 0, content: { type: "reasoning", reasoning: "thinking" } },
      { event: "message-finish", reason: "length" },
    ],
    message: new AIMessage({
      content: [{ type: "reasoning", reasoning: "thinking" }],
      response_metadata: { finish_reason: "length" },
    }),
  };
}

function plainTextTurn(text: string): ScriptedTurn {
  return {
    events: [
      { event: "message-start" },
      { event: "content-block-start", index: 0, content: { type: "text", text: "" } },
      { event: "content-block-delta", index: 0, delta: { type: "text-delta", text } },
      { event: "content-block-finish", index: 0, content: { type: "text", text } },
      { event: "message-finish", reason: "stop" },
    ],
    message: new AIMessage({ content: text, response_metadata: { finish_reason: "stop" } }),
  };
}

const fakeAgentState = {
  getState: async (threadId: string): Promise<ThreadState> => ({
    threadId,
    checkpointId: "ckpt_1",
    values: { messages: [] },
    next: [],
    createdAt: "2026-01-01T00:00:00Z",
  }),
};

async function runThroughRealSdk(model: NativeStreamModel, threadId: string) {
  const agent = await createPizzaBotAgent(PIZZA_BOT_AGENT.systemPrompt, { model });
  const streamFn = (input: RunInput, opts: RunOptions) => agent.streamProtocol(input, opts);
  const runs = new ProtocolRunManager(streamFn);
  const client = new Client({ apiUrl: "http://in-process.invalid" });
  const controller = new StreamController({
    assistantId: ASSISTANT_ID,
    client,
    threadId,
    transport: new InProcessTransport(runs, fakeAgentState, threadId).asAgentServerAdapter(),
    optimistic: false,
  });
  const release = controller.activate();
  try {
    await controller.submit({ messages: [{ role: "user", content: "summarize" }] });
    await settle();
    return controller.rootStore.getSnapshot();
  } finally {
    release();
  }
}

describe("a truncated orchestrator turn reaches the real SDK rootStore", () => {
  it("commits values.truncated = true when the turn ends at the token limit with no text", async () => {
    const snapshot = await runThroughRealSdk(
      new NativeStreamModel([reasoningOnlyTruncatedTurn()]),
      "t-truncated",
    );
    expect((snapshot.values as { truncated?: unknown }).truncated).toBe(true);
    expect(snapshot.isLoading).toBe(false);
    expect(snapshot.error).toBeUndefined();
  });

  it("commits values.truncated = false for a normal text turn", async () => {
    const snapshot = await runThroughRealSdk(new NativeStreamModel([plainTextTurn("All done.")]), "t-normal");
    expect((snapshot.values as { truncated?: unknown }).truncated).toBe(false);
  });
});
