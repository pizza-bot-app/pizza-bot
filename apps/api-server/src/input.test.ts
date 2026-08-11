import { describe, it, expect } from "vitest";
import { toRunInput } from "./input.js";

describe("toRunInput: request-body normalization", () => {
  it("maps { prompt } shorthand to a single user message", () => {
    expect(toRunInput({ prompt: "hi" })).toEqual({
      messages: [{ id: "u_0", role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
  });

  it("maps a LangGraph { input: { messages } } run", () => {
    const out = toRunInput({ input: { messages: [{ role: "user", content: "yo" }] } });
    expect(out).toEqual({
      messages: [{ id: "m_0", role: "user", parts: [{ type: "text", text: "yo" }] }],
    });
  });

  it("maps a top-level HITL command payload to a resume", () => {
    const cmd = { interruptId: "i1", decisions: [{ decision: "approve" }] };
    expect(toRunInput({ command: cmd })).toEqual({ command: cmd });
  });

  it("maps a HITL command NESTED under input (ApiClient shape)", () => {
    const cmd = { interruptId: "i2", decisions: [{ decision: "approve" }] };
    expect(toRunInput({ input: { command: cmd }, config: { configurable: { thread_id: "t" } } })).toEqual({
      command: cmd,
    });
  });

  it("falls back to empty messages for an unrecognized body", () => {
    expect(toRunInput({})).toEqual({ messages: [] });
  });

  it("keeps a file part and derives attachmentId from its attachment:// url", () => {
    const out = toRunInput({
      input: {
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "what is this?" },
              { type: "file", url: "attachment://abc123", mediaType: "image/png", name: "shot.png" },
            ],
          },
        ],
      },
    });
    expect(out).toEqual({
      messages: [
        {
          id: "m_0",
          role: "user",
          parts: [
            { type: "text", text: "what is this?" },
            { type: "file", url: "attachment://abc123", mediaType: "image/png", name: "shot.png", attachmentId: "abc123" },
          ],
        },
      ],
    });
  });

  it("drops an unknown/ill-formed part shape (a client can't smuggle a tool-call in)", () => {
    const out = toRunInput({
      input: {
        messages: [
          { role: "user", parts: [{ type: "tool-call", toolCallId: "x", name: "rm", args: {} }, { type: "text", text: "hi" }] },
        ],
      },
    });
    expect(out).toEqual({ messages: [{ id: "m_0", role: "user", parts: [{ type: "text", text: "hi" }] }] });
  });

  it("drops file parts that are not stored attachment references", () => {
    const out = toRunInput({
      input: {
        messages: [
          { role: "user", parts: [{ type: "file", url: "https://example.com/a.png", mediaType: "image/png" }] },
        ],
      },
    });
    expect(out).toEqual({ messages: [{ id: "m_0", role: "user", parts: [] }] });
  });
});
