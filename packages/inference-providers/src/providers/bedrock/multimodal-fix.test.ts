import {
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { normalizeMultimodalToolResultsForBedrock } from "./multimodal-fix.js";

describe("normalizeMultimodalToolResultsForBedrock", () => {
  it("normalizes DeepAgents image and file tool results for Bedrock", () => {
    const toolMessage = new ToolMessage({
      tool_call_id: "read-1",
      content: [
        { type: "text", text: "Screenshot:" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        {
          type: "file",
          mimeType: "application/pdf",
          data: "ZG9jdW1lbnQ=",
          metadata: { name: "report.pdf" },
        },
      ],
    });

    const normalized = normalizeMultimodalToolResultsForBedrock([toolMessage]);

    expect(normalized).not.toEqual([toolMessage]);
    expect(ToolMessage.isInstance(normalized[0])).toBe(true);
    expect(normalized[0]?.content).toEqual([
      { type: "text", text: "Screenshot:" },
      {
        type: "image",
        source_type: "base64",
        mime_type: "image/png",
        data: "aW1hZ2U=",
      },
      {
        type: "file",
        source_type: "base64",
        mime_type: "application/pdf",
        data: "ZG9jdW1lbnQ=",
        metadata: { name: "report.pdf" },
      },
    ]);
    expect(toolMessage.content).toEqual([
      { type: "text", text: "Screenshot:" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      {
        type: "file",
        mimeType: "application/pdf",
        data: "ZG9jdW1lbnQ=",
        metadata: { name: "report.pdf" },
      },
    ]);
  });

  it("preserves unrelated and already canonical messages", () => {
    const human = new HumanMessage("hello");
    const canonical = new ToolMessage({
      tool_call_id: "read-2",
      content: [{
        type: "image",
        source_type: "base64",
        mime_type: "image/png",
        data: "aW1hZ2U=",
      }],
    });
    const messages = [human, canonical];

    expect(normalizeMultimodalToolResultsForBedrock(messages)).toBe(messages);
  });
});
