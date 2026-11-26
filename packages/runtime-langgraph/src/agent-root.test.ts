/** Drives the real graph to pin what an agent definition gets as a thread's top-level agent. */
import { describe, expect, it } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import {
  BUILTIN_EVAL_TOOL_REF,
  BUILTIN_TASK_TOOL_REF,
  type AgentCatalog,
  type AgentCatalogEntry,
  type TodoAccess,
} from "@pizza-bot/core";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createAgentRootAgent } from "./index.js";

class ToolCapturingModel extends BaseChatModel<Record<string, never>> {
  readonly boundToolSets: string[][] = [];
  readonly descriptions: Record<string, string>[] = [];
  readonly systemPrompts: string[] = [];

  _llmType(): string {
    return "tool-capturing";
  }

  override bindTools(tools: Array<{ name: string; description?: string }>): this {
    this.boundToolSets.push(tools.map((item) => item.name));
    this.descriptions.push(Object.fromEntries(tools.map((item) => [item.name, item.description ?? ""])));
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

function definition(id: string, overrides: Partial<AgentCatalogEntry> = {}): AgentCatalogEntry {
  return {
    id,
    name: id,
    description: `Handles ${id} work.`,
    systemPrompt: `You are the ${id} agent.`,
    source: "user",
    declaredTools: [],
    skills: [],
    interruptOn: {},
    ...overrides,
  };
}

const unusedTodos = { list: () => [] } as unknown as TodoAccess;

async function firstTurn(agent: AgentCatalogEntry, agents: AgentCatalog = new Map()) {
  const model = new ToolCapturingModel({});
  const root = await createAgentRootAgent(agent, {
    model,
    checkpointer: new MemorySaver(),
    agents,
    todos: unusedTodos,
  });
  for await (const _event of root.streamProtocol(
    { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] },
    { threadId: `t-${agent.id}` },
  )) {
    // drain
  }
  return model;
}

describe("createAgentRootAgent", () => {
  it("runs on the definition's own prompt, without delegation, eval, or Todo tools", async () => {
    const model = await firstTurn(definition("researcher"), new Map([["writer", definition("writer")]]));
    expect(model.systemPrompts[0]).toContain("You are the researcher agent.");
    expect(model.systemPrompts[0]).not.toContain("Pizza Bot");
    const tools = model.boundToolSets[0] ?? [];
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("task");
    expect(tools).not.toContain("eval");
    expect(tools).not.toContain("create_todo");
  });

  it("delegates to the other agents only when granted builtin:task", async () => {
    const lead = definition("lead", { declaredTools: [BUILTIN_TASK_TOOL_REF] });
    const model = await firstTurn(lead, new Map([["lead", lead], ["writer", definition("writer")]]));
    expect(model.boundToolSets[0]).toContain("task");
    const roster = model.descriptions[0]!.task!;
    expect(roster).toContain("writer");
    expect(roster).not.toContain("lead");
  });

  it("gets eval only when it declares builtin:eval", async () => {
    const model = await firstTurn(definition("analyst", { declaredTools: [BUILTIN_EVAL_TOOL_REF] }));
    expect(model.boundToolSets[0]).toContain("eval");
  });

  it("refuses a tool grant that resolves to no loaded tool", async () => {
    await expect(
      createAgentRootAgent(definition("mailer", { declaredTools: ["mcp:mail:send"] }), {
        model: new ToolCapturingModel({}),
        catalog: { mail: ["send"] },
      }),
    ).rejects.toThrow(/agent "mailer"/);
  });

  it("pauses at the root for an approval the definition declares", async () => {
    class SendingModel extends ToolCapturingModel {
      override async _generate(messages: BaseMessage[]) {
        await super._generate(messages);
        const message = new AIMessage({
          content: "",
          tool_calls: [{ id: "send-1", name: "mail__send", args: { to: "ada" }, type: "tool_call" }],
        });
        return { generations: [{ message, text: "" }] };
      }
    }
    const send = tool(async () => "sent", { name: "mail__send", description: "Send mail.", schema: z.object({ to: z.string() }) });
    const mailer = definition("mailer", { declaredTools: ["mcp:mail:send"], interruptOn: { "mcp:mail:send": true } });
    const root = await createAgentRootAgent(mailer, {
      model: new SendingModel({}),
      checkpointer: new MemorySaver(),
      catalog: { mail: ["send"] },
      tools: { "mcp:mail:send": send },
    });
    for await (const _event of root.streamProtocol(
      { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "email ada" }] }] },
      { threadId: "t-mailer" },
    )) {
      // drain
    }
    const state = await root.getState("t-mailer");
    expect(state.awaitingInput).toBe(true);
    expect(JSON.stringify(state.interrupts)).toContain("mail__send");
  });
});

