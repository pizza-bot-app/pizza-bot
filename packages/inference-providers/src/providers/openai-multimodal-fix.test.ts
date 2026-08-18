import {
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { normalizeMultimodalToolResultsForOpenAiResponses } from "./openai-multimodal-fix.js";

describe("normalizeMultimodalToolResultsForOpenAiResponses", () => {
  it("normalizes DeepAgents text, image, and file tool results", () => {
    const toolMessage = new ToolMessage({
      tool_call_id: "read-1",
      content: [
        { type: "text", text: "Screenshot:" },
        {
          type: "image",
          mimeType: "image/png",
          data: "aW1hZ2U=",
          metadata: { detail: "high" },
        },
        {
          type: "file",
          mimeType: "application/pdf",
          data: "ZG9jdW1lbnQ=",
          metadata: { name: "report.pdf" },
        },
      ],
    });

    const normalized = normalizeMultimodalToolResultsForOpenAiResponses([toolMessage]);

    expect(ToolMessage.isInstance(normalized[0])).toBe(true);
    expect(normalized[0]?.content).toEqual([
      { type: "input_text", text: "Screenshot:" },
      {
        type: "input_image",
        detail: "high",
        image_url: "data:image/png;base64,aW1hZ2U=",
      },
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,ZG9jdW1lbnQ=",
        filename: "report.pdf",
      },
    ]);
    expect(toolMessage.content).toEqual([
      { type: "text", text: "Screenshot:" },
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        metadata: { detail: "high" },
      },
      {
        type: "file",
        mimeType: "application/pdf",
        data: "ZG9jdW1lbnQ=",
        metadata: { name: "report.pdf" },
      },
    ]);
  });

  it("preserves unrelated, unsupported, and native messages", () => {
    const human = new HumanMessage("hello");
    const unsupported = new ToolMessage({
      tool_call_id: "read-2",
      content: [{ type: "audio", mimeType: "audio/mp3", data: "YXVkaW8=" }],
    });
    const native = new ToolMessage({
      tool_call_id: "read-3",
      content: [{
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,aW1hZ2U=",
      }],
    });
    const messages = [human, unsupported, native];

    expect(normalizeMultimodalToolResultsForOpenAiResponses(messages)).toBe(messages);
  });

  it("falls back to auto for non-standard image detail values", () => {
    const toolMessage = new ToolMessage({
      tool_call_id: "read-4",
      content: [{
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        metadata: { detail: "original" },
      }],
    });

    expect(
      normalizeMultimodalToolResultsForOpenAiResponses([toolMessage])[0]?.content,
    ).toEqual([{
      type: "input_image",
      detail: "auto",
      image_url: "data:image/png;base64,aW1hZ2U=",
    }]);
  });
});
