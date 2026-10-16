/** Drives the real graph to pin that the truncated-turn flag describes the run that just finished, not the last model call ever. */
import { describe, expect, it } from "vitest";
import { AIMessage, type AIMessageFields, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { TRUNCATED_TURN_CHANNEL, type RunInput, type RunOptions } from "@pizza-bot/core";
import { createPizzaBotAgent, type LangGraphAgent } from "./index.js";
import { MAX_CUT_OFF_RETRIES, toolCallCutOffInstruction } from "./output-truncation-middleware.js";

type ScriptedTurn = { message: AIMessage } | { hangUntilAbort: { onEntered: () => void } };

class ScriptedModel extends BaseChatModel<Record<string, never>> {
  private i = 0;
  readonly inputs: BaseMessage[][] = [];

  constructor(private readonly script: ScriptedTurn[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    options: { signal?: AbortSignal },
  ): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    this.inputs.push(messages);
    const turn = this.script[this.i++];
    if (!turn) throw new Error("unexpected model call");
    if ("hangUntilAbort" in turn) {
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        turn.hangUntilAbort.onEntered();
      });
    }
    return { generations: [{ message: (turn as { message: AIMessage }).message, text: "" }] };
  }
}

function reasoningOnlyTruncated(): AIMessage {
  return new AIMessage({
    content: [{ type: "reasoning", reasoning: "thinking" }],
    response_metadata: { finish_reason: "length" },
  });
}

async function runTurn(agent: LangGraphAgent, threadId: string, signal?: AbortSignal): Promise<void> {
  const input: RunInput = {
    messages: [{ id: `u_${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ type: "text", text: "go" }] }],
  };
  const options: RunOptions = signal ? { threadId, signal } : { threadId };
  try {
    for await (const frame of agent.streamProtocol(input, options)) void frame;
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
}

async function truncatedFlag(agent: LangGraphAgent, threadId: string): Promise<unknown> {
  return (await agent.getState(threadId)).values[TRUNCATED_TURN_CHANNEL];
}

describe("truncated-turn flag across runs", () => {
  it("does not survive into a run that is stopped before the model replies", async () => {
    let onEntered!: () => void;
    const modelEntered = new Promise<void>((resolve) => (onEntered = resolve));
    const agent = await createPizzaBotAgent("Help the user.", {
      model: new ScriptedModel([{ message: reasoningOnlyTruncated() }, { hangUntilAbort: { onEntered } }]),
      checkpointer: new MemorySaver(),
    });
    const threadId = `truncated_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);
    expect(await truncatedFlag(agent, threadId)).toBe(true);

    const controller = new AbortController();
    const stoppedRun = runTurn(agent, threadId, controller.signal);
    // Inside the model call means beforeAgent has already checkpointed the reset.
    await modelEntered;
    controller.abort();
    await stoppedRun;
    expect(await truncatedFlag(agent, threadId)).toBe(false);
  }, 30_000);

  it("is cleared by a later normal turn", async () => {
    const agent = await createPizzaBotAgent("Help the user.", {
      model: new ScriptedModel([{ message: reasoningOnlyTruncated() }, { message: new AIMessage("All done.") }]),
      checkpointer: new MemorySaver(),
    });
    const threadId = `truncated_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);
    expect(await truncatedFlag(agent, threadId)).toBe(true);

    await runTurn(agent, threadId);
    expect(await truncatedFlag(agent, threadId)).toBe(false);
  }, 30_000);

  it("silently retries a cut-off tool call within the same run", async () => {
    const model = new ScriptedModel([{ message: cutOffEdit() }, { message: new AIMessage("Report updated.") }]);
    const agent = await createPizzaBotAgent("Help the user.", { model, checkpointer: new MemorySaver() });
    const threadId = `truncated_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);

    const messages = await threadMessages(agent, threadId);
    expect(messages.map((m) => m.getType())).toEqual(["human", "ai"]);
    expect(messages[1]!.text).toBe("Report updated.");
    expect(await truncatedFlag(agent, threadId)).toBe(false);
    expect(model.inputs).toHaveLength(2);
    expect(systemText(model.inputs[1]!)).toContain(toolCallCutOffInstruction(["edit_file"]));
    expect(model.inputs[1]!.some(hasInvalidToolCall)).toBe(false);
  }, 30_000);

  it("drops the hidden instruction once the retry succeeds", async () => {
    const model = new ScriptedModel([
      { message: cutOffEdit() },
      { message: new AIMessage("Report updated.") },
      { message: new AIMessage("Anything else?") },
    ]);
    const agent = await createPizzaBotAgent("Help the user.", { model, checkpointer: new MemorySaver() });
    const threadId = `truncated_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);
    await runTurn(agent, threadId);

    expect(systemText(model.inputs[2]!)).not.toContain(toolCallCutOffInstruction(["edit_file"]));
  }, 30_000);

  it(`falls back to the banner after ${MAX_CUT_OFF_RETRIES} silent retries`, async () => {
    const model = new ScriptedModel(
      Array.from({ length: MAX_CUT_OFF_RETRIES + 1 }, () => ({ message: cutOffEdit() })),
    );
    const agent = await createPizzaBotAgent("Help the user.", { model, checkpointer: new MemorySaver() });
    const threadId = `truncated_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);

    expect(model.inputs).toHaveLength(MAX_CUT_OFF_RETRIES + 1);
    expect(await truncatedFlag(agent, threadId)).toBe(true);
    const messages = await threadMessages(agent, threadId);
    expect(messages.filter(hasInvalidToolCall)).toHaveLength(1);
  }, 30_000);
});

function cutOffEdit(): AIMessage {
  return new AIMessage({
    content: [
      { type: "reasoning", reasoning: "" },
      { type: "invalid_tool_call", id: "call-1", name: "edit_file", args: '{"old_string":"unfin', error: "bad json" },
    ],
    response_metadata: { finish_reason: "length", output_version: "v1" },
  } as unknown as AIMessageFields);
}

function hasInvalidToolCall(message: BaseMessage): boolean {
  return Array.isArray(message.content) && message.content.some((b) => b.type === "invalid_tool_call");
}

function systemText(messages: BaseMessage[]): string {
  return messages.filter((m) => m.getType() === "system").map((m) => m.text).join("\n");
}

async function threadMessages(agent: LangGraphAgent, threadId: string): Promise<BaseMessage[]> {
  return (await agent.getState(threadId)).values.messages as unknown as BaseMessage[];
}
