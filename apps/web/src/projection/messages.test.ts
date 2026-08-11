import { describe, it, expect } from "vitest";
import type { UIPartLike, UIMessageLike } from "./adapter.js";
import {
  buildResumeCommand,
  buildBatchResumeCommand,
  parseInterruptActions,
  overlayInterrupt,
  sealOpenToolCalls,
  messagesToUI,
  hydratedMessageId,
  rawIndexOf,
  usageFromMessages,
  type RawMessage,
} from "./messages.js";

describe("buildResumeCommand", () => {
  it("carries editedArgs (and the tool name) for an edit decision", () => {
    const args = { to: "CHANGED@example.com", subject: "Edited", body: "New" };
    expect(buildResumeCommand("i1", "edit", args, "send_email")).toEqual({
      interruptId: "i1",
      decisions: [{ decision: "edit", editedArgs: args, editedName: "send_email" }],
    });
  });

  it("omits editedArgs for approve/reject", () => {
    expect(buildResumeCommand("i2", "approve")).toEqual({
      interruptId: "i2",
      decisions: [{ decision: "approve" }],
    });
    expect(buildResumeCommand("i3", "reject")).toEqual({
      interruptId: "i3",
      decisions: [{ decision: "reject" }],
    });
  });

  it("carries the human message for a respond decision (and a reject reason)", () => {
    expect(buildResumeCommand("i4", "respond", undefined, undefined, "Use the other address")).toEqual({
      interruptId: "i4",
      decisions: [{ decision: "respond", message: "Use the other address" }],
    });
    expect(buildResumeCommand("i5", "reject", undefined, undefined, "Not now")).toEqual({
      interruptId: "i5",
      decisions: [{ decision: "reject", message: "Not now" }],
    });
    expect(buildResumeCommand("i6", "respond")).toEqual({
      interruptId: "i6",
      decisions: [{ decision: "respond" }],
    });
  });
});

describe("parseInterruptActions (batched-aware)", () => {
  it("reads N actionRequests + allowedDecisions from a batched interrupt value", () => {
    const value = {
      actionRequests: [
        { name: "email_read", args: { id: "1" } },
        { name: "email_read", args: { id: "2" } },
        { name: "email_read", args: { id: "3" } },
      ],
      reviewConfigs: [{ actionName: "email_read", allowedDecisions: ["approve", "reject"] }],
    };
    const { actions, allowedDecisions } = parseInterruptActions(value);
    expect(actions).toEqual([
      { toolName: "email_read", args: { id: "1" } },
      { toolName: "email_read", args: { id: "2" } },
      { toolName: "email_read", args: { id: "3" } },
    ]);
    expect(allowedDecisions).toEqual(["approve", "reject"]);
  });

  it("reads a lone interrupt as a single action; defaults decisions when absent", () => {
    const { actions, allowedDecisions } = parseInterruptActions({
      actionRequests: [{ name: "send_email", args: { to: "x@y.z" } }],
    });
    expect(actions).toEqual([{ toolName: "send_email", args: { to: "x@y.z" } }]);
    expect(allowedDecisions).toEqual(["approve", "edit", "reject"]);
  });
});

describe("buildBatchResumeCommand", () => {
  it("emits ONE decision per gated call (the HITL middleware requires a matching count)", () => {
    expect(buildBatchResumeCommand("i1", "approve", 3)).toEqual({
      interruptId: "i1",
      decisions: [{ decision: "approve" }, { decision: "approve" }, { decision: "approve" }],
    });
    expect(buildBatchResumeCommand("i2", "reject", 2, undefined, undefined, "no")).toEqual({
      interruptId: "i2",
      decisions: [
        { decision: "reject", message: "no" },
        { decision: "reject", message: "no" },
      ],
    });
  });

  it("degrades to a single decision for a lone interrupt (count 1)", () => {
    expect(buildBatchResumeCommand("i3", "approve", 1)).toEqual({
      interruptId: "i3",
      decisions: [{ decision: "approve" }],
    });
  });
});

describe("overlayInterrupt (batched-aware card overlay)", () => {
  const assistantWithOpenCalls = (n: number): UIMessageLike => ({
    id: "a1",
    role: "assistant",
    parts: Array.from({ length: n }, (_, i) => ({
      type: "tool-email_read",
      toolCallId: `r${i + 1}`,
      state: "input-available" as const,
      input: { id: String(i + 1) },
    })),
  });

  it("supersedes a lone open card with the approval card (re-keyed to the interrupt id)", () => {
    const msgs = [assistantWithOpenCalls(1)];
    const { actions, allowedDecisions } = parseInterruptActions({
      actionRequests: [{ name: "email_read", args: { id: "1" } }],
      reviewConfigs: [{ allowedDecisions: ["approve", "reject"] }],
    });
    const out = overlayInterrupt(msgs, "INT", actions, allowedDecisions);
    const parts = out[0]!.parts as Extract<UIPartLike, { type: `tool-${string}` }>[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ toolCallId: "INT", state: "approval-requested" });
    expect(parts[0]!.batch).toBeUndefined();
  });

  it("collapses N open cards into ONE batch card and drops the extras (bug #2)", () => {
    const msgs = [assistantWithOpenCalls(3)];
    const { actions, allowedDecisions } = parseInterruptActions({
      actionRequests: [
        { name: "email_read", args: { id: "1" } },
        { name: "email_read", args: { id: "2" } },
        { name: "email_read", args: { id: "3" } },
      ],
      reviewConfigs: [{ allowedDecisions: ["approve", "reject"] }],
    });
    const out = overlayInterrupt(msgs, "BATCH", actions, allowedDecisions);
    const parts = out[0]!.parts as Extract<UIPartLike, { type: `tool-${string}` }>[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ toolCallId: "BATCH", state: "approval-requested" });
    expect(parts[0]!.batch).toHaveLength(3);
    expect(parts[0]!.batch!.map((b) => b.args)).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  it("preserves already-terminal cards and only supersedes the open ones", () => {
    const msgs: UIMessageLike[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool-search", toolCallId: "done", state: "output-available", output: "ok" },
          { type: "tool-email_read", toolCallId: "r1", state: "input-available", input: { id: "1" } },
        ],
      },
    ];
    const { actions, allowedDecisions } = parseInterruptActions({
      actionRequests: [{ name: "email_read", args: { id: "1" } }],
    });
    const out = overlayInterrupt(msgs, "INT", actions, allowedDecisions);
    const parts = out[0]!.parts as Extract<UIPartLike, { type: `tool-${string}` }>[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ toolCallId: "done", state: "output-available" });
    expect(parts[1]).toMatchObject({ toolCallId: "INT", state: "approval-requested" });
  });
});

describe("messagesToUI — hydration reconstructs tool cards", () => {
  const human = (text: string): RawMessage => ({ id: ["langchain", "HumanMessage"], kwargs: { content: text } });
  const aiWithToolCall = (text: string, tc: { id: string; name: string; args: unknown }): RawMessage => ({
    id: ["langchain", "AIMessage"],
    kwargs: { content: text, tool_calls: [tc] },
  });
  const toolResult = (id: string, content: string, status = "success"): RawMessage => ({
    id: ["langchain", "ToolMessage"],
    kwargs: { content, tool_call_id: id, status },
  });

  it("renders a user text turn", () => {
    const ui = messagesToUI([human("hello")]);
    expect(ui).toEqual([{ id: "h_0", role: "user", parts: [{ type: "text", text: "hello" }] }]);
  });

  it("renders a user turn with an attachment reference as a text + file part", () => {
    const withFile: RawMessage = {
      id: ["langchain", "HumanMessage"],
      kwargs: {
        content: [
          { type: "text", text: "what is this?" },
          { type: "file", url: "attachment://a1", mimeType: "image/png", name: "shot.png" },
        ] as unknown as RawMessage["content"],
      },
    };
    const ui = messagesToUI([withFile]);
    expect(ui).toEqual([
      {
        id: "h_0",
        role: "user",
        parts: [
          { type: "text", text: "what is this?" },
          { type: "file", url: "attachment://a1", mediaType: "image/png", filename: "shot.png" },
        ],
      },
    ]);
  });

  it("folds a reasoning_content block into a reasoning part BEFORE the answer text", () => {
    const aiWithReasoning: RawMessage = {
      id: ["langchain", "AIMessage"],
      kwargs: {
        content: [
          { type: "reasoning_content", reasoningText: { text: "17×20=340, +51=391.", signature: "sig" } },
          { type: "text", text: "17 × 23 = 391" },
        ] as unknown as RawMessage["content"],
      },
    };
    const ui = messagesToUI([aiWithReasoning]);
    expect(ui[0]!.parts).toEqual([
      { type: "reasoning", text: "17×20=340, +51=391." },
      { type: "text", text: "17 × 23 = 391" },
    ]);
  });

  it("folds a v1 `reasoning` block (text under `reasoning`) into a reasoning part", () => {
    const aiWithV1Reasoning: RawMessage = {
      id: ["langchain", "AIMessage"],
      kwargs: {
        content: [
          { type: "reasoning", reasoning: "let me work it out." },
          { type: "text", text: "the answer" },
        ] as unknown as RawMessage["content"],
      },
    };
    const ui = messagesToUI([aiWithV1Reasoning]);
    expect(ui[0]!.parts).toEqual([
      { type: "reasoning", text: "let me work it out." },
      { type: "text", text: "the answer" },
    ]);
  });

  it("omits the reasoning part for a signature-only block (no visible thinking)", () => {
    const signatureOnly: RawMessage = {
      id: ["langchain", "AIMessage"],
      kwargs: {
        content: [
          { type: "reasoning_content", reasoningText: { signature: "sig" } },
          { type: "text", text: "answer" },
        ] as unknown as RawMessage["content"],
      },
    };
    const ui = messagesToUI([signatureOnly]);
    expect(ui[0]!.parts).toEqual([{ type: "text", text: "answer" }]);
  });

  it("reconstructs a tool call as a tool part in input-available", () => {
    const ui = messagesToUI([aiWithToolCall("let me check", { id: "c1", name: "ls", args: { path: "/" } })]);
    expect(ui).toEqual([
      {
        id: "h_0",
        role: "assistant",
        parts: [
          { type: "text", text: "let me check" },
          { type: "tool-ls", toolCallId: "c1", state: "input-available", input: { path: "/" } },
        ],
      },
    ]);
  });

  it("folds a ToolMessage result onto its call (Completed), NOT a separate bubble", () => {
    const ui = messagesToUI([
      aiWithToolCall("", { id: "c1", name: "ls", args: { path: "/" } }),
      toolResult("c1", "No files found in /"),
    ]);
    expect(ui).toHaveLength(1);
    const parts = ui[0]!.parts;
    expect(parts).toEqual([
      { type: "tool-ls", toolCallId: "c1", state: "output-available", input: { path: "/" }, output: "No files found in /" },
    ]);
  });

  it("preserves durable message IDs for exact search-result navigation", () => {
    const assistant = aiWithToolCall("", { id: "c1", name: "ls", args: { path: "/" } });
    assistant.kwargs!.id = "assistant-1";
    const result = toolResult("c1", "No files found in /");
    result.kwargs!.id = "tool-result-1";

    const ui = messagesToUI([assistant, result], "thread-1");

    expect(ui[0]).toMatchObject({ sourceMessageId: "assistant-1" });
    expect(ui[0]!.parts[0]).toMatchObject({ resultMessageId: "tool-result-1" });
  });

  it("uses the search index fallback ID when a message has no durable ID", () => {
    const ui = messagesToUI([human("hello")], "thread-1");
    expect(ui[0]).toMatchObject({ sourceMessageId: "thread-1:0" });
  });

  it("marks a failed tool result as output-error with errorText", () => {
    const ui = messagesToUI([
      aiWithToolCall("", { id: "c9", name: "ls", args: {} }),
      toolResult("c9", "boom", "error"),
    ]);
    expect(ui[0]!.parts[0]).toMatchObject({
      type: "tool-ls",
      state: "output-error",
      output: "boom",
      errorText: "boom",
    });
  });

  it("matches a result to its call across intervening messages", () => {
    const ui = messagesToUI([
      aiWithToolCall("first", { id: "c1", name: "ls", args: {} }),
      aiWithToolCall("second", { id: "c2", name: "read", args: {} }),
      toolResult("c1", "done-1"),
      toolResult("c2", "done-2"),
    ]);
    expect(ui).toHaveLength(2);
    expect(ui[0]!.parts.find((p) => "toolCallId" in p && p.toolCallId === "c1")).toMatchObject({
      state: "output-available",
      output: "done-1",
    });
    expect(ui[1]!.parts.find((p) => "toolCallId" in p && p.toolCallId === "c2")).toMatchObject({
      state: "output-available",
      output: "done-2",
    });
  });

  it("ids encode the RAW history index across collapsed tool results (fork boundary)", () => {
    const ui = messagesToUI([
      aiWithToolCall("first", { id: "c1", name: "ls", args: {} }),
      toolResult("c1", "done-1"),
      { id: ["langchain", "AIMessage"], kwargs: { content: "" } },
      { id: ["langchain", "AIMessage"], kwargs: { content: "final answer" } },
    ]);
    expect(ui).toHaveLength(2);
    expect(ui.map((m) => m.id)).toEqual(["h_0", "h_3"]);
    expect(rawIndexOf(ui[1]!.id)).toBe(3);
  });

  it("hydratedMessageId/rawIndexOf round-trip; rawIndexOf rejects non-hydrated ids", () => {
    expect(rawIndexOf(hydratedMessageId(7))).toBe(7);
    expect(rawIndexOf("a_interrupt")).toBeNull();
    expect(rawIndexOf("interrupt")).toBeNull();
  });

  it("drops an orphan tool result (no matching call) rather than leaking text", () => {
    const ui = messagesToUI([toolResult("ghost", '{"raw":"json"}')]);
    expect(ui).toEqual([]);
  });

  it("skips empty messages (no text, no tool calls)", () => {
    expect(messagesToUI([{ id: ["langchain", "AIMessage"], kwargs: { content: "" } }])).toEqual([]);
  });

});

describe("usageFromMessages — context-window occupancy from the latest AI turn", () => {
  const human = (): RawMessage => ({ id: ["langchain", "HumanMessage"], kwargs: { content: "hi" } });
  const aiInstance = (input: number, output: number): RawMessage => ({
    id: ["langchain", "AIMessage"],
    usage_metadata: { input_tokens: input, output_tokens: output },
  });
  const aiWire = (input: number, output: number): RawMessage => ({
    id: ["langchain", "AIMessage"],
    kwargs: { content: "hi", usage_metadata: { input_tokens: input, output_tokens: output } },
  });

  it("reads instance-form usage_metadata", () => {
    expect(usageFromMessages([human(), aiInstance(1200, 340)])).toEqual({ input: 1200, output: 340 });
  });

  it("reads serialized (kwargs) usage_metadata", () => {
    expect(usageFromMessages([human(), aiWire(900, 50)])).toEqual({ input: 900, output: 50 });
  });

  it("reads streamed usage from additional_kwargs.usage (no usage_metadata mid-stream)", () => {
    const aiStreamed: RawMessage = {
      id: ["langchain", "AIMessage"],
      additional_kwargs: { usage: { input_tokens: 700, output_tokens: 42 } },
    };
    expect(usageFromMessages([human(), aiStreamed])).toEqual({ input: 700, output: 42 });
  });

  it("takes the LATEST reporting message (input_tokens IS current occupancy, not a sum)", () => {
    const raw = [human(), aiInstance(1000, 200), human(), aiInstance(2500, 300)];
    expect(usageFromMessages(raw)).toEqual({ input: 2500, output: 300 });
  });

  it("skips trailing messages without usage (e.g. a tool result) to find the last AI turn", () => {
    const toolResult: RawMessage = { id: ["langchain", "ToolMessage"], tool_call_id: "c1", kwargs: { content: "ok" } };
    expect(usageFromMessages([aiInstance(1500, 100), toolResult])).toEqual({ input: 1500, output: 100 });
  });

  it("defaults a missing half to 0", () => {
    expect(usageFromMessages([{ id: ["langchain", "AIMessage"], usage_metadata: { input_tokens: 800 } }])).toEqual({
      input: 800,
      output: 0,
    });
  });

  it("returns undefined when no message reports usage (fresh thread)", () => {
    expect(usageFromMessages([human()])).toBeUndefined();
    expect(usageFromMessages([])).toBeUndefined();
  });
});

describe("sealOpenToolCalls — no tool card outlives its run", () => {
  const msg = (id: string, parts: UIPartLike[]): UIMessageLike => ({ id, role: "assistant", parts });
  const openTool = (id: string): UIPartLike => ({
    type: "tool-task",
    toolCallId: id,
    state: "input-available",
    input: { subagent_type: "general-purpose" },
  });

  it("seals an open (Running) tool card to output-error with an explanation", () => {
    const out = sealOpenToolCalls([msg("a", [openTool("c1")])]);
    expect(out[0]!.parts[0]).toMatchObject({
      type: "tool-task",
      toolCallId: "c1",
      state: "output-error",
      errorText: "Run ended before this tool finished.",
    });
  });

  it("uses a caller-supplied errorText", () => {
    const out = sealOpenToolCalls([msg("a", [openTool("c1")])], "Run failed.");
    expect(out[0]!.parts[0]).toMatchObject({ state: "output-error", errorText: "Run failed." });
  });

  it("seals input-streaming (Pending) cards too", () => {
    const out = sealOpenToolCalls([
      msg("a", [{ type: "tool-x", toolCallId: "c1", state: "input-streaming" }]),
    ]);
    expect(out[0]!.parts[0]).toMatchObject({ state: "output-error" });
  });

  it("leaves an approval-requested (live HITL) card untouched", () => {
    const parts: UIPartLike[] = [{ type: "tool-send", toolCallId: "i1", state: "approval-requested", input: {} }];
    const out = sealOpenToolCalls([msg("a", parts)]);
    expect(out[0]!.parts[0]).toMatchObject({ state: "approval-requested" });
  });

  it("leaves already-terminal cards untouched", () => {
    const in_ = [
      msg("a", [{ type: "tool-x", toolCallId: "c1", state: "output-available", output: "ok" }]),
      msg("b", [{ type: "text", text: "hi" }]),
    ];
    expect(sealOpenToolCalls(in_)).toBe(in_);
  });

  it("returns the same reference when there are no messages", () => {
    const in_: UIMessageLike[] = [];
    expect(sealOpenToolCalls(in_)).toBe(in_);
  });
});
