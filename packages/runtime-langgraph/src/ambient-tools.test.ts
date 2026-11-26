/** Drives a real agent graph through a background check-in's tools and its ask_user pause. */
import { describe, expect, it } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { AgentCatalogEntry, AmbientTodoAccess, Todo } from "@pizza-bot/core";
import { createAgentRootAgent } from "./index.js";

type Call = { name: string; args: Record<string, unknown> };

class ScriptedModel extends BaseChatModel<Record<string, never>> {
  readonly systemPrompts: string[] = [];
  readonly boundToolSets: string[][] = [];
  private turn = 0;

  constructor(private readonly script: Call[][]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(tools: Array<{ name: string }>): this {
    this.boundToolSets.push(tools.map((item) => item.name));
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    const system = messages.find(SystemMessage.isInstance);
    if (system) this.systemPrompts.push(system.text);
    const calls = this.script[this.turn++] ?? [];
    const message = calls.length
      ? new AIMessage({
          content: "",
          tool_calls: calls.map((call, i) => ({ id: `call-${this.turn}-${i}`, type: "tool_call" as const, ...call })),
        })
      : new AIMessage({ content: "done for now" });
    return { generations: [{ message, text: "" }] };
  }
}

const owner: AgentCatalogEntry = {
  id: "researcher",
  name: "Researcher",
  description: "Finds sources.",
  systemPrompt: "You research.",
  source: "user",
  declaredTools: [],
  skills: [],
  interruptOn: {},
};

const todo: Todo = {
  id: "todo-1",
  title: "Compare flights",
  notes: "",
  importance: "normal",
  steps: [],
  completed: false,
  threadIds: [],
  owner: "researcher",
  history: [],
  notify: "immediate",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function recordingAccess() {
  const calls: Array<[string, string, unknown]> = [];
  const access: AmbientTodoAccess = {
    todoForThread: () => todo,
    recordProgress: (threadId, update) => {
      calls.push(["progress", threadId, update]);
      return { ...todo, completed: update.completed ?? false };
    },
    notifyUser: async (threadId, message) => {
      calls.push(["notify", threadId, message]);
      return "delivered";
    },
    reassign: async (threadId, toAgentId, note) => {
      calls.push(["reassign", threadId, { toAgentId, note }]);
      return { ...todo, owner: toAgentId };
    },
    snooze: (threadId, until, note) => {
      calls.push(["snooze", threadId, { until, note }]);
      return { ...todo, snoozedUntil: until };
    },
    requestTodo: async (threadId, toAgentId, title, note) => {
      calls.push(["request", threadId, { toAgentId, title, note }]);
      return { ...todo, id: "child", title, owner: toAgentId, parentTodoId: todo.id };
    },
  };
  return { access, calls };
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _event of stream) {
    // drain
  }
}

const checkIn = { messages: [{ id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "Check in." }] }] };

describe("ambient check-in tools", () => {
  it("records progress and notifies through the host, scoped to the calling thread", async () => {
    const model = new ScriptedModel([
      [
        { name: "update_todo", args: { note: "Found three fares.", completed: true } },
        { name: "notify_user", args: { message: "Fares are in; the cheapest is Tuesday." } },
      ],
    ]);
    const { access, calls } = recordingAccess();
    const agent = await createAgentRootAgent(owner, { model, checkpointer: new MemorySaver() }, { ambient: access });
    await drain(agent.streamProtocol(checkIn, { threadId: "bg-1" }));

    expect(model.systemPrompts[0]).toContain("You research.");
    expect(model.systemPrompts[0]).toContain("Nothing you write in this conversation reaches the user.");
    expect(model.boundToolSets[0]).toEqual(
      expect.arrayContaining(["update_todo", "notify_user", "ask_user", "reassign_todo"]),
    );
    expect(calls).toEqual([
      ["progress", "bg-1", { note: "Found three fares.", completed: true }],
      ["notify", "bg-1", "Fares are in; the cheapest is Tuesday."],
    ]);
  });

  it("holds checklist step titles to the Todo title rule", async () => {
    const update = (title: string) => [{ name: "update_todo", args: { note: "Planned.", steps: [{ title }] } }];
    const model = new ScriptedModel([update("   "), update("x".repeat(201)), update("  Compare fares  ")]);
    const { access, calls } = recordingAccess();
    const agent = await createAgentRootAgent(owner, { model, checkpointer: new MemorySaver() }, { ambient: access });
    await drain(agent.streamProtocol(checkIn, { threadId: "bg-steps" }));

    expect(calls).toEqual([["progress", "bg-steps", { note: "Planned.", steps: [{ title: "Compare fares" }] }]]);
  });

  it("pauses ask_user for a typed reply and never runs it", async () => {
    const model = new ScriptedModel([[{ name: "ask_user", args: { question: "Window or aisle?" } }]]);
    const { access, calls } = recordingAccess();
    const agent = await createAgentRootAgent(owner, { model, checkpointer: new MemorySaver() }, { ambient: access });
    await drain(agent.streamProtocol(checkIn, { threadId: "bg-2" }));

    const state = await agent.getState("bg-2");
    expect(state.awaitingInput).toBe(true);
    const pending = JSON.stringify(state.interrupts);
    expect(pending).toContain("ask_user");
    expect(pending).toContain("Window or aisle?");
    expect(pending).toContain('"allowedDecisions":["respond"]');
    // The host reads the question from this shape (agent-host askUserQuestion).
    const request = (state.interrupts?.[0]?.value as { actionRequests?: Array<{ name: string; args: { question?: string } }> })
      .actionRequests?.[0];
    expect(request).toMatchObject({ name: "ask_user", args: { question: "Window or aisle?" } });
    expect(calls).toEqual([]);
  });

  it("hands the Todo on through the host", async () => {
    const model = new ScriptedModel([[{ name: "reassign_todo", args: { toAgent: "booker", note: "Book the Tuesday fare." } }]]);
    const { access, calls } = recordingAccess();
    const agent = await createAgentRootAgent(owner, { model, checkpointer: new MemorySaver() }, { ambient: access });
    await drain(agent.streamProtocol(checkIn, { threadId: "bg-3" }));
    expect(calls).toEqual([["reassign", "bg-3", { toAgentId: "booker", note: "Book the Tuesday fare." }]]);
  });

  it("snoozes and requests subtasks through the host", async () => {
    const model = new ScriptedModel([
      [
        { name: "request_todo", args: { toAgent: "booker", title: "Hold the Tuesday fare", note: "Need a 24h hold." } },
        { name: "snooze_until", args: { until: "2026-12-01T09:00:00-08:00", reason: "Fares update Monday." } },
      ],
    ]);
    const { access, calls } = recordingAccess();
    const agent = await createAgentRootAgent(owner, { model, checkpointer: new MemorySaver() }, { ambient: access });
    await drain(agent.streamProtocol(checkIn, { threadId: "bg-4" }));
    expect(model.boundToolSets[0]).toEqual(expect.arrayContaining(["request_todo", "snooze_until"]));
    expect(calls).toEqual([
      ["request", "bg-4", { toAgentId: "booker", title: "Hold the Tuesday fare", note: "Need a 24h hold." }],
      ["snooze", "bg-4", { until: "2026-12-01T09:00:00-08:00", note: "Fares update Monday." }],
    ]);
  });

  it("is absent from an agent's ordinary conversations", async () => {
    const model = new ScriptedModel([]);
    const agent = await createAgentRootAgent(owner, { model, checkpointer: new MemorySaver() });
    await drain(agent.streamProtocol(checkIn, { threadId: "chat" }));
    expect(model.boundToolSets[0]).not.toContain("notify_user");
    expect(model.systemPrompts[0]).not.toContain("working unattended");
  });
});

describe("updateStateAsFinished", () => {
  it("writes a message without leaving the thread looking mid-run", async () => {
    const agent = await createAgentRootAgent(owner, { model: new ScriptedModel([]), checkpointer: new MemorySaver() });
    const message = { messages: [{ role: "assistant", content: "Fares are in.", id: "m1" }] };

    await agent.updateState("plain", message);
    expect((await agent.getState("plain")).next).not.toEqual([]);

    await agent.updateStateAsFinished("finished", message);
    const state = await agent.getState("finished");
    expect(state.next).toEqual([]);
    expect((state.values as { messages?: unknown[] }).messages).toHaveLength(1);
  });
});
