import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  sanitizeBedrockDocumentName,
  sanitizeDocumentNamesForBedrock,
  stripReasoningForBedrock,
} from "./outbound-messages.js";

describe("stripReasoningForBedrock", () => {
  it("removes a v1 `reasoning` block (the shape the createAgent path emits)", () => {
    const msg = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "let me think..." },
        { type: "text", text: "the answer" },
      ] as unknown as string,
    });
    const [out] = stripReasoningForBedrock([msg]);
    expect(out).not.toBe(msg);
    expect(out!.content).toEqual([{ type: "text", text: "the answer" }]);
    expect(out).toBeInstanceOf(AIMessage);
  });

  it("removes a legacy v0 `reasoning_content` block too", () => {
    const msg = new AIMessage({
      content: [
        { type: "reasoning_content", reasoningText: { signature: "s", text: "thinking" } },
        { type: "text", text: "the answer" },
      ] as unknown as string,
    });
    const [out] = stripReasoningForBedrock([msg]);
    expect(out!.content).toEqual([{ type: "text", text: "the answer" }]);
  });

  it("strips signature-only and redacted v0 reasoning blocks too", () => {
    const msg = new AIMessage({
      content: [
        { type: "reasoning_content", reasoningText: { signature: "s" } },
        { type: "reasoning_content", redactedContent: "abc==" },
        { type: "text", text: "hi" },
      ] as unknown as string,
    });
    const [out] = stripReasoningForBedrock([msg]);
    expect(out!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("strips a reasoning block sharing a turn with a tool call (the delegation path)", () => {
    const msg = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "delegating..." },
        { type: "tool_call", id: "t1", name: "task", args: {} },
      ] as unknown as string,
    });
    const [out] = stripReasoningForBedrock([msg]);
    expect(out!.content).toEqual([{ type: "tool_call", id: "t1", name: "task", args: {} }]);
  });

  it("returns messages without reasoning blocks by reference", () => {
    const human = new HumanMessage("plain");
    const ai = new AIMessage({ content: [{ type: "text", text: "no reasoning here" }] as unknown as string });
    const input = [human, ai];
    const output = stripReasoningForBedrock(input);
    const [outHuman, outAi] = output;
    expect(output).toBe(input);
    expect(outHuman).toBe(human);
    expect(outAi).toBe(ai);
  });

  it("drops a reasoning-only AI message instead of producing empty assistant content", () => {
    const human = new HumanMessage("question");
    const reasoningOnly = new AIMessage({
      content: [{ type: "reasoning", reasoning: "unfinished..." }] as unknown as string,
    });
    const nextHuman = new HumanMessage("follow-up");

    const output = stripReasoningForBedrock([human, reasoningOnly, nextHuman]);

    expect(output).toEqual([human, nextHuman]);
  });

  it("keeps a legacy tool-call turn whose content contains only reasoning", () => {
    const msg = new AIMessage({
      content: [{ type: "reasoning_content", reasoningText: { signature: "s" } }] as unknown as string,
      tool_calls: [{ id: "t1", name: "search", args: { q: "pizza" }, type: "tool_call" }],
    });

    const [output] = stripReasoningForBedrock([msg]);

    expect(output).toBeInstanceOf(AIMessage);
    expect(output!.content).toEqual([]);
    expect((output as AIMessage).tool_calls).toEqual(msg.tool_calls);
  });

  it("rebuilds v1 tool-call content when tool calls live only on the message", () => {
    const msg = new AIMessage({
      content: [{ type: "reasoning", reasoning: "searching..." }] as unknown as string,
      response_metadata: { output_version: "v1" },
      tool_calls: [{ id: "t1", name: "search", args: { q: "pizza" }, type: "tool_call" }],
    });
    // Mimic reconstructed v1 history where only `tool_calls` survived.
    (msg as { content: unknown }).content = [{ type: "reasoning", reasoning: "searching..." }];

    const [output] = stripReasoningForBedrock([msg]);

    expect(output!.content).toEqual([
      { type: "tool_call", id: "t1", name: "search", args: { q: "pizza" } },
    ]);
  });

  it("leaves string-content messages untouched (by reference)", () => {
    const human = new HumanMessage("plain string content");
    const input = [human];
    const output = stripReasoningForBedrock(input);
    const [out] = output;
    expect(output).toBe(input);
    expect(out).toBe(human);
  });
});

describe("sanitizeBedrockDocumentName", () => {
  it("preserves the empirically allowed charset (letters, digits, underscore, whitespace, hyphen, parens, brackets)", () => {
    expect(sanitizeBedrockDocumentName("Report (final) [v2] - draft_1")).toBe("Report (final) [v2] - draft_1");
  });

  it("replaces disallowed characters with spaces", () => {
    expect(sanitizeBedrockDocumentName("report.pdf")).toBe("report pdf");
    expect(sanitizeBedrockDocumentName("blogs/blog ideas")).toBe("blogs blog ideas");
    expect(sanitizeBedrockDocumentName("a,b;c:d!e?f")).toBe("a b c d e f");
  });

  it("replaces non-ASCII characters (emoji, accents, CJK) with spaces", () => {
    expect(sanitizeBedrockDocumentName("✍️ Blogs")).toBe("Blogs");
    expect(sanitizeBedrockDocumentName("café")).toBe("caf");
    expect(sanitizeBedrockDocumentName("文档 notes")).toBe("notes");
  });

  it("collapses runs of whitespace (including tabs/newlines) to one space", () => {
    expect(sanitizeBedrockDocumentName("a  b")).toBe("a b");
    expect(sanitizeBedrockDocumentName("a\tb")).toBe("a b");
    expect(sanitizeBedrockDocumentName("a\nb")).toBe("a b");
    expect(sanitizeBedrockDocumentName("a . b")).toBe("a b");
  });

  it("falls back to 'attachment' when nothing survives", () => {
    expect(sanitizeBedrockDocumentName("")).toBe("attachment");
    expect(sanitizeBedrockDocumentName("✍️")).toBe("attachment");
    expect(sanitizeBedrockDocumentName("///")).toBe("attachment");
    expect(sanitizeBedrockDocumentName("   ")).toBe("attachment");
  });

  it("caps length at 200 characters (Bedrock's observed max)", () => {
    const long = "a".repeat(500);
    const out = sanitizeBedrockDocumentName(long);
    expect(out).toHaveLength(200);
  });

  it("is idempotent", () => {
    const once = sanitizeBedrockDocumentName("✍️ Blogs/Blog ideas.md");
    expect(sanitizeBedrockDocumentName(once)).toBe(once);
  });
});

describe("sanitizeDocumentNamesForBedrock", () => {
  it("rewrites `metadata.name` on file blocks in-message", () => {
    const msg = new HumanMessage({
      content: [
        { type: "text", text: "explain" },
        {
          type: "file",
          source_type: "base64",
          mime_type: "text/markdown",
          data: "IyBoaQ==",
          metadata: { name: "✍️ Blogs/Blog ideas.md" },
        },
      ] as unknown as string,
    });
    const [out] = sanitizeDocumentNamesForBedrock([msg]);
    expect(out).not.toBe(msg);
    const content = out!.content as Array<Record<string, unknown>>;
    expect((content[1]!.metadata as { name: string }).name).toBe("Blogs Blog ideas md");
  });

  it("preserves message reference when no file block needs rewriting", () => {
    const msg = new HumanMessage({
      content: [
        { type: "text", text: "hello" },
        { type: "file", metadata: { name: "report" } },
      ] as unknown as string,
    });
    const [out] = sanitizeDocumentNamesForBedrock([msg]);
    expect(out).toBe(msg);
  });

  it("passes through plain-text messages and messages without file blocks", () => {
    const a = new HumanMessage("plain");
    const b = new HumanMessage({ content: [{ type: "text", text: "still plain" }] as unknown as string });
    const out = sanitizeDocumentNamesForBedrock([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("preserves file blocks without metadata.name (no sanitization needed)", () => {
    const msg = new HumanMessage({
      content: [{ type: "file", source_type: "base64", mime_type: "image/png", data: "QUJD" }] as unknown as string,
    });
    const [out] = sanitizeDocumentNamesForBedrock([msg]);
    expect(out).toBe(msg);
  });
});
