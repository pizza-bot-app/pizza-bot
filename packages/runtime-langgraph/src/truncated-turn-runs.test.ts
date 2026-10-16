/** Drives the real graph to pin that the truncated-turn flag describes the run that just finished, not the last model call ever. */
import { describe, expect, it } from "vitest";
import { AIMessage, type AIMessageFields, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { TRUNCATED_TURN_CHANNEL, type RunInput, type RunOptions } from "@pizza-bot/core";
import { createPizzaBotAgent, type LangGraphAgent } from "./index.js";
import { toolCallCutOffNotice } from "./output-truncation-middleware.js";

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

  it("tells the model on the next turn that its cut-off tool call did not run", async () => {
    const model = new ScriptedModel([
      {
        message: new AIMessage({
          content: [
            { type: "reasoning", reasoning: "" },
            { type: "invalid_tool_call", id: "call-1", name: "edit_file", args: '{"old_string":"unfin', error: "bad json" },
          ],
          response_metadata: { finish_reason: "length", output_version: "v1" },
        } as unknown as AIMessageFields),
      },
      { message: new AIMessage("Retrying in smaller pieces.") },
    ]);
    const agent = await createPizzaBotAgent("Help the user.", { model, checkpointer: new MemorySaver() });
    const threadId = `truncated_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);
    expect(await truncatedFlag(agent, threadId)).toBe(true);
    await runTurn(agent, threadId);

    const replayedTurn = model.inputs[1]!.find((m) => AIMessage.isInstance(m));
    expect(replayedTurn?.text).toContain(toolCallCutOffNotice(["edit_file"]).trim());
  }, 30_000);
});
