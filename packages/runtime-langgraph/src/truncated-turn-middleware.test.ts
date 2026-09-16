import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, type AIMessageFields } from "@langchain/core/messages";
import { TRUNCATED_TURN_KEY, isTruncatedTurn, truncatedTurnMiddleware } from "./truncated-turn-middleware.js";

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
    afterModel: (state: { messages: unknown[] }) => Record<string, unknown>;
  };

  it("writes the flag from the latest model reply on every call, false included", () => {
    expect(middleware.afterModel({ messages: [new HumanMessage("go"), reasoningOnly("length")] })).toEqual({
      [TRUNCATED_TURN_KEY]: true,
    });
    expect(middleware.afterModel({ messages: [new HumanMessage("go"), new AIMessage("done")] })).toEqual({
      [TRUNCATED_TURN_KEY]: false,
    });
  });
});
