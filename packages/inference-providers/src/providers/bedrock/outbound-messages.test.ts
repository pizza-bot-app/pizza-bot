import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { stripReasoningForBedrock } from "./outbound-messages.js";

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
