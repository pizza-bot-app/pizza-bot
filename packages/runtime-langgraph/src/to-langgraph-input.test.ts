import { describe, it, expect } from "vitest";
import { Command } from "@langchain/langgraph";
import { toLangGraphInput } from "./stream-protocol.js";
import { attachmentUrl, type RunInput } from "@pizza-bot/core";

describe("toLangGraphInput", () => {
  it("collapses a pure-text turn to a plain string", () => {
    const input: RunInput = {
      messages: [{ id: "u0", role: "user", parts: [{ type: "text", text: "hello" }] }],
    };
    const out = toLangGraphInput(input) as { messages: Array<{ role: string; content: unknown }> };
    expect(out.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("maps a file part to a reference block alongside the text (no bytes)", () => {
    const input: RunInput = {
      messages: [
        {
          id: "u0",
          role: "user",
          parts: [
            { type: "text", text: "look" },
            { type: "file", mediaType: "image/png", url: attachmentUrl("a1"), name: "shot.png", attachmentId: "a1" },
          ],
        },
      ],
    };
    const out = toLangGraphInput(input) as { messages: Array<{ role: string; content: unknown }> };
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "file", url: attachmentUrl("a1"), mimeType: "image/png", name: "shot.png" },
    ]);
  });

  it("seeds graph input state", () => {
    expect(toLangGraphInput({ graphInput: { body: { a: 1 } } })).toEqual({ input: { body: { a: 1 } } });
  });

  it("resumes a human-node response keyed by its interrupt id", () => {
    const out = toLangGraphInput({ command: { interruptId: "i1", response: { ok: true } } });
    expect(out).toBeInstanceOf(Command);
    expect((out as Command).resume).toEqual({ i1: { ok: true } });
  });
});
