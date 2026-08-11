/** Drives the real graph to pin DeepAgents' default synchronous delegation. */
import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
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
  it("exposes the default general-purpose task worker without skills", async () => {
    expect(await boundTools()).toContain("task");
  });

  it("keeps task available when a skill worker exists", async () => {
    expect(await boundTools(workerSkill)).toContain("task");
  });

  it("routes skill workers from task metadata without root skills middleware", async () => {
    const model = await captureModel(workerSkill);
    const task = model.boundToolDescriptions[0]?.find((tool) => tool.name === "task");
    expect(task?.description).toContain("- worker: Handles delegated work.");
  });
});
