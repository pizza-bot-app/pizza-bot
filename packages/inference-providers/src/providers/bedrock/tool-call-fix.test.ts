import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { repairEmptyToolCallEvent, repairEmptyToolCalls } from "./tool-call-fix.js";

describe("Bedrock empty tool-call repair", () => {
  it("turns an empty-argument stream failure into a zero-argument tool call", () => {
    const event = {
      event: "content-block-finish",
      index: 1,
      content: {
        type: "invalid_tool_call",
        id: "tooluse_1",
        name: "get_my_personal_details",
        args: "",
        error: "Failed to parse tool call arguments as JSON",
      },
    } as ChatModelStreamEvent;

    expect(repairEmptyToolCallEvent(event)).toEqual({
      event: "content-block-finish",
      index: 1,
      content: {
        type: "tool_call",
        id: "tooluse_1",
        name: "get_my_personal_details",
        args: {},
      },
    });
  });

  it("does not hide malformed non-empty tool arguments", () => {
    const event = {
      event: "content-block-finish",
      index: 0,
      content: {
        type: "invalid_tool_call",
        id: "tooluse_2",
        name: "search_accounts",
        args: '{"name":',
        error: "Failed to parse tool call arguments as JSON",
      },
    } as ChatModelStreamEvent;

    expect(repairEmptyToolCallEvent(event)).toBe(event);
  });

  it("repairs an assembled v1 message while preserving other content", () => {
    const message = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "Checking identity." },
        {
          type: "invalid_tool_call",
          id: "tooluse_3",
          name: "get_my_personal_details",
          args: "",
          error: "Failed to parse tool call arguments as JSON",
        },
      ] as unknown as string,
      response_metadata: { output_version: "v1" },
    });

    const repaired = repairEmptyToolCalls(message) as AIMessage;

    expect(repaired).not.toBe(message);
    expect(repaired).toBeInstanceOf(AIMessage);
    expect(repaired.content).toEqual([
      { type: "reasoning", reasoning: "Checking identity." },
      {
        type: "tool_call",
        id: "tooluse_3",
        name: "get_my_personal_details",
        args: {},
      },
    ]);
    expect(repaired.tool_calls).toEqual([
      {
        type: "tool_call",
        id: "tooluse_3",
        name: "get_my_personal_details",
        args: {},
      },
    ]);
  });
});
