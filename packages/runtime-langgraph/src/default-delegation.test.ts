/** Drives the real graph to pin DeepAgents' default synchronous delegation. */
import { describe, expect, it } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { AgentCatalog, RunInput, RunOptions, SkillCatalog } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";

class ToolCapturingModel extends BaseChatModel<Record<string, never>> {
  readonly boundToolSets: string[][] = [];
  readonly systemPrompts: string[] = [];
  readonly boundToolDescriptions: Array<
    Array<{ name: string; description: string | undefined }>
  > = [];

  _llmType(): string {
    return "tool-capturing";
  }

  override bindTools(tools: Array<{ name: string; description?: string }>): this {
    this.boundToolSets.push(tools.map((item) => item.name));
    this.boundToolDescriptions.push(tools.map(({ name, description }) => ({ name, description })));
    return this;
  }

  async _generate(
    messages: BaseMessage[],
  ): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const system = messages.find(SystemMessage.isInstance);
    if (system) this.systemPrompts.push(system.text);
    const message = new AIMessage({ content: "done" });
    return { generations: [{ message, text: "done" }] };
  }
}

function agents(...ids: string[]): AgentCatalog {
  return new Map(ids.map((id) => [
    id,
    {
      id,
      name: id,
      description: id === "worker" ? "Handles delegated work." : `Handles ${id} work.`,
      systemPrompt: "Complete the task.",
      source: "user" as const,
      declaredTools: [],
      skills: [],
      interruptOn: {},
    },
  ]));
}

const worker = agents("worker");
const parallelWorkers = agents("worker-a", "worker-b");

const guideSkill: SkillCatalog = new Map([[
  "guide",
  {
    id: "guide",
    name: "guide",
    description: "Explains the product.",
    source: "builtin",
    files: [{
      path: "/skills/guide/SKILL.md",
      content: "---\nname: guide\ndescription: Explains the product.\n---\n\nRead the references.",
    }],
  },
]]);

class ParallelDelegationModel extends BaseChatModel<Record<string, never>> {
  private call = 0;

  _llmType(): string {
    return "parallel-delegation";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const call = this.call++;
    const message = call === 0
      ? new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "task-a",
              name: "task",
              args: { description: "Run worker A.", subagent_type: "worker-a" },
              type: "tool_call",
            },
            {
              id: "task-b",
              name: "task",
              args: { description: "Run worker B.", subagent_type: "worker-b" },
              type: "tool_call",
            },
          ],
        })
      : new AIMessage({ content: call < 3 ? `worker-${call} done` : "all done" });
    return {
      generations: [{
        message,
        text: typeof message.content === "string" ? message.content : "",
      }],
    };
  }
}

async function captureModel(
  deps: { agents?: AgentCatalog; skills?: SkillCatalog; rootSkills?: string[] } = {},
): Promise<ToolCapturingModel> {
  const model = new ToolCapturingModel({});
  const agent = await createPizzaBotAgent("Help the user.", { model, ...deps });
  const input: RunInput = {
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
  };
  const options: RunOptions = { threadId: `delegation_${Math.random().toString(36).slice(2)}` };
  // Drain the turn: the model replies without tool calls, and stopping at the first
  // bound tool set would race the model call that records the system prompt.
  for await (const _ of agent.streamProtocol(input, options)) {
    // The captured tools and prompts are the result.
  }
  return model;
}

async function boundTools(agentCatalog?: AgentCatalog): Promise<string[]> {
  return (await captureModel(agentCatalog ? { agents: agentCatalog } : {})).boundToolSets[0] ?? [];
}

describe("Pizza Bot delegation", () => {
  it("withholds task without agents, since no worker could receive a dispatch", async () => {
    expect(await boundTools()).not.toContain("task");
  });

  it("keeps task available when a subagent exists", async () => {
    expect(await boundTools(worker)).toContain("task");
  });

  it("routes subagents from task metadata", async () => {
    const model = await captureModel({ agents: worker });
    const task = model.boundToolDescriptions[0]?.find((tool) => tool.name === "task");
    expect(task?.description).toContain("- worker: Handles delegated work.");
  });

  it("offers only subagents, never DeepAgents' capability-free general-purpose one", async () => {
    const model = await captureModel({ agents: worker });
    const task = model.boundToolDescriptions[0]?.find((tool) => tool.name === "task");
    expect(task?.description).not.toContain("general-purpose");
  });

  it("lists root skills in the orchestrator prompt only when mounted", async () => {
    const mounted = await captureModel({ skills: guideSkill, rootSkills: ["guide"] });
    expect(mounted.systemPrompts[0]).toContain("/skills/guide/SKILL.md");
    expect(mounted.systemPrompts[0]).toContain("Explains the product.");

    const unmounted = await captureModel({ skills: guideSkill });
    expect(unmounted.systemPrompts[0]).not.toContain("Explains the product.");
  });

  it("keeps run-limit counters local when subagents run in parallel", async () => {
    const threadId = `parallel_delegation_${Math.random().toString(36).slice(2)}`;
    const agent = await createPizzaBotAgent("Help the user.", {
      model: new ParallelDelegationModel({}),
      agents: parallelWorkers,
      checkpointer: new MemorySaver(),
    });

    for await (const _ of agent.streamProtocol(
      {
        messages: [{
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Delegate both tasks." }],
        }],
      },
      { threadId },
    )) {
      // Drain the protocol stream so the graph and its checkpoints finish.
    }

    const state = await agent.getState(threadId);
    expect(state.values.threadModelCallCount).toBe(2);
    expect(state.values.threadToolCallCount).toEqual({ __all__: 2 });
  });
});
