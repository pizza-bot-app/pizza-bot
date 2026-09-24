import { describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type AIMessageFields,
  type BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createSubAgent } from "deepagents";
import { TRUNCATED_TURN_CHANNEL } from "@pizza-bot/core";
import {
  OUTPUT_TRUNCATION_NOTICE,
  isTruncatedTurn,
  outputTruncationMiddleware,
  truncatedTurnMiddleware,
} from "./output-truncation-middleware.js";

interface TestRequest {
  messages: BaseMessage[];
}

type Handler = (request: TestRequest) => Promise<AIMessage>;

function wrap() {
  const middleware = outputTruncationMiddleware() as unknown as {
    wrapModelCall: (
      request: TestRequest,
      handler: Handler,
    ) => Promise<AIMessage>;
  };
  return middleware.wrapModelCall;
}

function message(content: string, finishReason: string): AIMessage {
  return new AIMessage({
    content,
    response_metadata: { finish_reason: finishReason },
  });
}

class ReasoningLimitedModel extends BaseChatModel<Record<string, never>> {
  calls = 0;

  _llmType(): string {
    return "reasoning-limited";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<{
    generations: Array<{ message: AIMessage; text: string }>;
  }> {
    this.calls += 1;
    const response = new AIMessage({
      content: [{
        type: "reasoning",
        reasoning: "unfinished reasoning",
        index: 0,
      }],
      response_metadata: {
        finish_reason: "length",
        output_version: "v1",
      },
    } as unknown as AIMessageFields);
    return { generations: [{ message: response, text: "" }] };
  }
}

describe("outputTruncationMiddleware", () => {
  it("passes a completed response through unchanged", async () => {
    const response = message("complete", "stop");
    const handler = vi.fn<Handler>().mockResolvedValue(response);

    await expect(
      wrap()({ messages: [new HumanMessage("start")] }, handler),
    ).resolves.toBe(response);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("marks a length-limited string response without retrying", async () => {
    const response = message("Bedrock rate lim", "length");
    const handler = vi.fn<Handler>().mockResolvedValue(response);

    const result = await wrap()(
      { messages: [new HumanMessage("start")] },
      handler,
    );

    expect(result).not.toBe(response);
    expect(result).toBeInstanceOf(AIMessage);
    expect(result.content).toBe("Bedrock rate lim" + OUTPUT_TRUNCATION_NOTICE);
    expect(result.response_metadata).toBe(response.response_metadata);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("appends a text notice after reasoning-only array content", async () => {
    const reasoning = {
      type: "reasoning",
      reasoning: "unfinished reasoning",
      index: 0,
    };
    const response = new AIMessage({
      content: [reasoning],
      response_metadata: { finish_reason: "length", output_version: "v1" },
    } as unknown as AIMessageFields);

    const result = await wrap()(
      { messages: [new HumanMessage("start")] },
      async () => response,
    );

    expect(result.content).toEqual([
      reasoning,
      { type: "text", text: OUTPUT_TRUNCATION_NOTICE },
    ]);
    expect(result.text).toBe(OUTPUT_TRUNCATION_NOTICE);
  });

  it("preserves indexed content block order without merging blocks", async () => {
    const blocks = [
      { type: "text", text: "AAA", index: 0 },
      { type: "text", text: "BBB", index: 1 },
    ];
    const response = new AIMessage({
      content: blocks,
      response_metadata: { finish_reason: "length", output_version: "v1" },
    } as unknown as AIMessageFields);

    const result = await wrap()(
      { messages: [new HumanMessage("start")] },
      async () => response,
    );

    expect(result.content).toEqual([
      ...blocks,
      { type: "text", text: OUTPUT_TRUNCATION_NOTICE },
    ]);
    expect(result.text).toBe("AAABBB" + OUTPUT_TRUNCATION_NOTICE);
  });

  it.each([
    ["stop_reason", "max_tokens"],
    ["stopReason", "MAX-TOKENS"],
    ["finishReason", "max_output_tokens"],
  ])("recognizes provider output-limit metadata in %s", async (key, reason) => {
    const response = new AIMessage({
      content: "partial",
      response_metadata: { [key]: reason },
    });

    await expect(
      wrap()(
        { messages: [new HumanMessage("start")] },
        async () => response,
      ),
    ).resolves.toHaveProperty(
      "content",
      "partial" + OUTPUT_TRUNCATION_NOTICE,
    );
  });

  it("leaves a length-limited tool-call turn to normal agent routing", async () => {
    const response = new AIMessage({
      content: "checking",
      response_metadata: { finish_reason: "length" },
      tool_calls: [{ id: "call-1", name: "lookup", args: { id: 42 } }],
    });

    await expect(
      wrap()(
        { messages: [new HumanMessage("start")] },
        async () => response,
      ),
    ).resolves.toBe(response);
  });

  it("marks reasoning-only output through the real DeepAgents worker stack", async () => {
    const model = new ReasoningLimitedModel({});
    const worker = createSubAgent({
      name: "limited-worker",
      description: "Returns a truncated response.",
      systemPrompt: "Complete the task.",
      model,
      tools: [],
      middleware: [outputTruncationMiddleware()],
    });

    const result = await worker.invoke({
      messages: [new HumanMessage("start")],
    });
    const final = result.messages.at(-1);

    expect(model.calls).toBe(1);
    expect(final).toBeInstanceOf(AIMessage);
    expect(final?.text).toBe(OUTPUT_TRUNCATION_NOTICE);
  });
});

function reasoningOnly(finishReason: string): AIMessage {
  return new AIMessage({
    content: [{ type: "reasoning", reasoning: "unfinished reasoning", index: 0 }],
    response_metadata: { finish_reason: finishReason, output_version: "v1" },
  } as unknown as AIMessageFields);
}

describe("isTruncatedTurn", () => {
  it("is true for a reasoning-only turn that stopped at the token limit", () => {
    expect(isTruncatedTurn(reasoningOnly("length"))).toBe(true);
  });

  it("recognizes Bedrock's provider-native stop reason", () => {
    const message = new AIMessage({
      content: [{ type: "reasoning", reasoning: "…", index: 0 }],
      response_metadata: { stopReason: "max_tokens" },
    } as unknown as AIMessageFields);
    expect(isTruncatedTurn(message)).toBe(true);
  });

  it("is false when the limit was hit but some text still reached the user", () => {
    const message = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "…", index: 0 },
        { type: "text", text: "partial re", index: 1 },
      ],
      response_metadata: { finish_reason: "length" },
    } as unknown as AIMessageFields);
    expect(isTruncatedTurn(message)).toBe(false);
  });

  it("is false for a string reply cut short — the user still sees text", () => {
    expect(
      isTruncatedTurn(new AIMessage({ content: "partial", response_metadata: { finish_reason: "length" } })),
    ).toBe(false);
  });

  it("is false for a reasoning-only turn that ended normally", () => {
    expect(isTruncatedTurn(reasoningOnly("stop"))).toBe(false);
  });

  it("is false for a length-limited tool call, which still routes to the tool", () => {
    const message = new AIMessage({
      content: "",
      response_metadata: { finish_reason: "length" },
      tool_calls: [{ id: "call-1", name: "lookup", args: {} }],
    });
    expect(isTruncatedTurn(message)).toBe(false);
  });

  it("is false for anything but an AI message", () => {
    expect(isTruncatedTurn(new HumanMessage("hi"))).toBe(false);
    expect(isTruncatedTurn(undefined)).toBe(false);
  });
});

describe("truncatedTurnMiddleware", () => {
  const middleware = truncatedTurnMiddleware() as unknown as {
    beforeAgent: () => Record<string, unknown>;
    afterModel: (state: { messages: unknown[] }) => Record<string, unknown>;
  };

  it("clears the flag when a run starts", () => {
    expect(middleware.beforeAgent()).toEqual({ [TRUNCATED_TURN_CHANNEL]: false });
  });

  it("writes the flag from the latest model reply on every call, false included", () => {
    expect(middleware.afterModel({ messages: [new HumanMessage("go"), reasoningOnly("length")] })).toEqual({
      [TRUNCATED_TURN_CHANNEL]: true,
    });
    expect(middleware.afterModel({ messages: [new HumanMessage("go"), new AIMessage("done")] })).toEqual({
      [TRUNCATED_TURN_CHANNEL]: false,
    });
  });
});
