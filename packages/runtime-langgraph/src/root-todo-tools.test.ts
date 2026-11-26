/** Drives the real orchestrator to pin that only the root agent holds the Todo tools. */
import { describe, expect, it } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { AgentCatalog, TodoAccess } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";

class DelegatingModel extends BaseChatModel<Record<string, never>> {
  readonly boundToolSets: string[][] = [];
  private call = 0;

  _llmType(): string {
    return "delegating";
  }

  override bindTools(tools: Array<{ name: string }>): this {
    this.boundToolSets.push(tools.map((item) => item.name));
    return this;
  }

  async _generate(_messages: BaseMessage[]) {
    const call = this.call++;
    const message = call === 0
      ? new AIMessage({
          content: "",
          tool_calls: [{ id: "t1", name: "task", args: { description: "Do it.", subagent_type: "worker" }, type: "tool_call" }],
        })
      : new AIMessage({ content: "done" });
    return { generations: [{ message, text: "done" }] };
  }
}

const worker: AgentCatalog = new Map([[
  "worker",
  {
    id: "worker",
    name: "worker",
    description: "Handles delegated work.",
    systemPrompt: "Complete the task.",
    source: "user" as const,
    declaredTools: [],
    skills: [],
    interruptOn: {},
  },
]]);

describe("Todo tools", () => {
  it("are bound for the orchestrator and never for a delegated subagent", async () => {
    const model = new DelegatingModel({});
    const todos = { list: () => [], get: () => undefined } as unknown as TodoAccess;
    const agent = await createPizzaBotAgent("You are Pizza Bot.", {
      model,
      checkpointer: new MemorySaver(),
      agents: worker,
      todos,
    });
    for await (const _event of agent.streamProtocol(
      { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "delegate" }] }] },
      { threadId: "root-tools" },
    )) {
      // drain
    }
    const [root, ...rest] = model.boundToolSets;
    expect(root).toEqual(expect.arrayContaining(["list_todos", "create_todo", "update_todo", "task"]));
    expect(rest.length).toBeGreaterThan(0);
    const subagentSets = rest.filter((tools) => !tools.includes("task"));
    expect(subagentSets.length).toBeGreaterThan(0);
    for (const tools of subagentSets) expect(tools).not.toContain("create_todo");
  });
});
