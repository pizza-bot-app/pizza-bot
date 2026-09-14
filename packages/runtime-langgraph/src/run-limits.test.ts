/** Drives the real graph to pin the tool-call budget as per-turn, not per-thread. */
import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { RunInput, RunOptions } from "@pizza-bot/core";
import { AGENT_RUN_LIMITS, createPizzaBotAgent, type LangGraphAgent } from "./index.js";

/** Asks for `perResponse` ls calls on every model call, so only a limiter can stop it. */
class LoopingToolModel extends BaseChatModel<Record<string, never>> {
  calls = 0;
  perResponse: number;

  constructor(perResponse: number) {
    super({});
    this.perResponse = perResponse;
  }

  _llmType(): string {
    return "looping-tool";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const call = ++this.calls;
    const message = new AIMessage({
      content: "",
      tool_calls: Array.from({ length: this.perResponse }, (_, index) => ({
        id: `ls_${call}_${index}`,
        name: "ls",
        args: {},
        type: "tool_call" as const,
      })),
    });
    return { generations: [{ message, text: "" }] };
  }
}

async function runTurn(agent: LangGraphAgent, threadId: string): Promise<void> {
  const input: RunInput = {
    messages: [{
      id: `u_${Math.random().toString(36).slice(2)}`,
      role: "user",
      parts: [{ type: "text", text: "List the files." }],
    }],
  };
  const options: RunOptions = { threadId };
  for await (const frame of agent.streamProtocol(input, options)) {
    void frame;
  }
}

async function toolCallsUsed(agent: LangGraphAgent, threadId: string): Promise<number> {
  const state = await agent.getState(threadId);
  const counts = state.values.threadToolCallCount as Record<string, number> | undefined;
  return counts?.__all__ ?? 0;
}

describe("orchestrator run limits", () => {
  it("gives every turn its own tool-call budget", async () => {
    const agent = await createPizzaBotAgent("Help the user.", {
      model: new LoopingToolModel(1),
      checkpointer: new MemorySaver(),
      maxToolCalls: 3,
    });
    const threadId = `run_limits_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);
    expect(await toolCallsUsed(agent, threadId)).toBe(3);

    // An exhausted turn must not leave the next one with a spent budget.
    await runTurn(agent, threadId);
    expect(await toolCallsUsed(agent, threadId)).toBe(6);
  }, 60_000);

  it("blocks the excess of a batched request rather than failing the turn", async () => {
    const agent = await createPizzaBotAgent("Help the user.", {
      model: new LoopingToolModel(4),
      checkpointer: new MemorySaver(),
      maxToolCalls: 6,
    });
    const threadId = `run_limits_batch_${Math.random().toString(36).slice(2)}`;

    await expect(runTurn(agent, threadId)).resolves.toBeUndefined();
    expect(await toolCallsUsed(agent, threadId)).toBe(6);
  }, 60_000);

  it("stops a tool loop at the model-call ceiling when the limit is off", async () => {
    const model = new LoopingToolModel(1);
    const agent = await createPizzaBotAgent("Help the user.", {
      model,
      checkpointer: new MemorySaver(),
      maxToolCalls: -1,
    });
    const threadId = `run_limits_uncapped_${Math.random().toString(36).slice(2)}`;

    await runTurn(agent, threadId);

    expect(model.calls).toBe(AGENT_RUN_LIMITS.orchestrator.modelCalls);
    const state = await agent.getState(threadId);
    const messages = state.values.messages as Array<{ content?: unknown }>;
    expect(String(messages.at(-1)?.content)).toContain("Model call limits exceeded");
  }, 60_000);
});
