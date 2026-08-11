import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type AIMessageChunkFields,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import {
  convertGoogleChunksToEvents,
  prepareGoogleMessages,
} from "./google-tool-call-fix.js";

describe("Google thought-signature compatibility", () => {
  it("replays signed v1 tool calls as provider-native function calls", () => {
    const original = new AIMessage({
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_call",
          id: "call-1",
          name: "search",
          args: { query: "AWS" },
          thoughtSignature: "opaque-signature",
        },
      ],
      tool_calls: [{
        type: "tool_call",
        id: "call-1",
        name: "search",
        args: { query: "AWS" },
      }],
      response_metadata: { output_version: "v1", model_provider: "google" },
    });

    const prepared = prepareGoogleMessages([
      new HumanMessage("Search for AWS"),
      original,
    ]);

    expect(prepared[0]).not.toBeInstanceOf(AIMessage);
    expect(prepared[1]).not.toBe(original);
    expect((prepared[1] as AIMessage).content).toEqual([
      { type: "text", text: "Let me check." },
      {
        type: "functionCall",
        functionCall: {
          id: "call-1",
          name: "search",
          args: { query: "AWS" },
        },
        thoughtSignature: "opaque-signature",
      },
    ]);
    expect(prepared[1]?.response_metadata.output_version).toBeUndefined();
    expect(original.response_metadata.output_version).toBe("v1");
    expect(original.content[1]).toMatchObject({
      type: "tool_call",
      thoughtSignature: "opaque-signature",
    });
  });

  it("preserves generated tool IDs and signatures in v3 stream events", async () => {
    const chunks = (async function* () {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: [{
            type: "functionCall",
            functionCall: { name: "search", args: { query: "AWS" } },
            thoughtSignature: "opaque-signature",
          }],
          tool_calls: [{
            type: "tool_call",
            id: "lc-tool-call-generated",
            name: "search",
            args: { query: "AWS" },
            thoughtSignature: "opaque-signature",
          }],
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
        } as unknown as AIMessageChunkFields),
        generationInfo: { finishReason: "STOP" },
      });
    })();

    const events = [];
    for await (const event of convertGoogleChunksToEvents(chunks)) {
      events.push(event);
    }

    expect(events).toContainEqual({
      event: "content-block-finish",
      index: 0,
      content: {
        type: "tool_call",
        id: "lc-tool-call-generated",
        name: "search",
        args: { query: "AWS" },
        index: 0,
        thoughtSignature: "opaque-signature",
      },
    });
    expect(events.at(-1)).toEqual({
      event: "message-finish",
      reason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
      responseMetadata: { model_provider: "google" },
    });
  });

  it("assigns one stable tool ID when Gemini omits functionCall.id", async () => {
    const chunks = (async function* () {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: [{
            type: "functionCall",
            functionCall: {
              name: "read_file",
              args: { file_path: "/skills/health-report/SKILL.md" },
            },
          }],
          tool_calls: [{
            type: "tool_call",
            name: "read_file",
            args: { file_path: "/skills/health-report/SKILL.md" },
          }],
        } as unknown as AIMessageChunkFields),
        generationInfo: { finishReason: "STOP" },
      });
    })();

    const events = [];
    for await (const event of convertGoogleChunksToEvents(
      chunks,
      () => "lc-tool-call-generated",
    )) {
      events.push(event);
    }

    const toolEvents = events.filter((event) =>
      event.event === "content-block-start" ||
      event.event === "content-block-delta" ||
      event.event === "content-block-finish"
    );
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0]).toMatchObject({
      content: { type: "tool_call_chunk", id: "lc-tool-call-generated" },
    });
    expect(toolEvents[1]).toMatchObject({
      delta: {
        type: "block-delta",
        fields: { type: "tool_call_chunk", id: "lc-tool-call-generated" },
      },
    });
    expect(toolEvents[2]).toMatchObject({
      content: { type: "tool_call", id: "lc-tool-call-generated" },
    });
  });
});
