import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { toLangGraphInput, withoutResentTurn } from "./stream-protocol.js";
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

describe("withoutResentTurn", () => {
  const turn = (content: unknown) => ({ messages: [{ role: "user", content }] });

  it("re-runs an unanswered user message instead of repeating it", () => {
    expect(withoutResentTurn(turn("hello"), new HumanMessage("hello"))).toEqual({ messages: [] });
  });

  it("compares attachment blocks, not just text", () => {
    const blocks = [{ type: "text", text: "look" }, { type: "file", url: "attachment://a1", mimeType: "image/png" }];
    expect(withoutResentTurn(turn(blocks), new HumanMessage({ content: blocks as never }))).toEqual({ messages: [] });
    expect(withoutResentTurn(turn("look"), new HumanMessage({ content: blocks as never }))).toEqual(turn("look"));
  });

  it("appends a different message, or any message after a reply", () => {
    expect(withoutResentTurn(turn("hello"), new HumanMessage("hi"))).toEqual(turn("hello"));
    expect(withoutResentTurn(turn("hello"), new AIMessage("hello"))).toEqual(turn("hello"));
    expect(withoutResentTurn(turn("hello"), undefined)).toEqual(turn("hello"));
  });
});
