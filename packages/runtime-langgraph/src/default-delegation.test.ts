/** Drives the real graph to pin DeepAgents' default synchronous delegation. */
import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { RunInput, RunOptions, SkillCatalog } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";

class ToolCapturingModel extends BaseChatModel<Record<string, never>> {
  readonly boundToolSets: string[][] = [];
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

  async _generate(): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const message = new AIMessage({ content: "done" });
    return { generations: [{ message, text: "done" }] };
  }
}

const workerSkill: SkillCatalog = new Map([[
  "worker",
  {
    id: "worker",
    name: "Worker",
    description: "Handles delegated work.",
    source: "user",
    declaredTools: [],
    interruptOn: {},
    files: [{
      path: "/skills/worker/SKILL.md",
      content: "---\nname: worker\ndescription: Handles delegated work.\n---\n\nComplete the task.",
    }],
  },
]]);

const parallelWorkerSkills: SkillCatalog = new Map(
  ["worker-a", "worker-b"].map((id) => [
    id,
    {
      id,
      name: id,
      description: `Handles ${id} work.`,
      source: "user" as const,
      declaredTools: [],
      interruptOn: {},
      files: [{
        path: `/skills/${id}/SKILL.md`,
        content: `---\nname: ${id}\ndescription: Handles ${id} work.\n---\n\nComplete the task.`,
      }],
    },
  ]),
);

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

async function captureModel(skills?: SkillCatalog): Promise<ToolCapturingModel> {
  const model = new ToolCapturingModel({});
  const agent = await createPizzaBotAgent("Help the user.", { model, ...(skills ? { skills } : {}) });
  const input: RunInput = {
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
  };
  const options: RunOptions = { threadId: `delegation_${Math.random().toString(36).slice(2)}` };
  for await (const _ of agent.streamProtocol(input, options)) {
    if (model.boundToolSets.length > 0) break;
  }
  return model;
}

async function boundTools(skills?: SkillCatalog): Promise<string[]> {
  return (await captureModel(skills)).boundToolSets[0] ?? [];
}

describe("Pizza Bot delegation", () => {
  it("withholds task without skills, since no worker could receive a dispatch", async () => {
    expect(await boundTools()).not.toContain("task");
  });

  it("keeps task available when a skill worker exists", async () => {
    expect(await boundTools(workerSkill)).toContain("task");
  });

  it("routes skill workers from task metadata without root skills middleware", async () => {
    const model = await captureModel(workerSkill);
    const task = model.boundToolDescriptions[0]?.find((tool) => tool.name === "task");
    expect(task?.description).toContain("- worker: Handles delegated work.");
  });

  it("offers only skill workers, never DeepAgents' capability-free general-purpose one", async () => {
    const model = await captureModel(workerSkill);
    const task = model.boundToolDescriptions[0]?.find((tool) => tool.name === "task");
    expect(task?.description).not.toContain("general-purpose");
  });

  it("keeps run-limit counters local when skill workers run in parallel", async () => {
    const threadId = `parallel_delegation_${Math.random().toString(36).slice(2)}`;
    const agent = await createPizzaBotAgent("Help the user.", {
      model: new ParallelDelegationModel({}),
      skills: parallelWorkerSkills,
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
