/** Pins the v3 frames a compiled GraphSpec emits, including an agent node's nested approval pause. */
import { describe, expect, it } from "vitest";
import { compileGraphSpec, createPizzaBotAgent } from "@pizza-bot/runtime-langgraph";
import { PIZZA_BOT_AGENT, parseGraphSpec, type AgentCatalog } from "@pizza-bot/core";
import { MemorySaver, type ProtocolEvent } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

class ScriptedModel extends BaseChatModel<Record<string, never>> {
  private i = 0;
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType(): string {
    return "scripted-graph-conformance";
  }
  override bindTools(): this {
    return this;
  }
  async _generate() {
    const message = this.script[Math.min(this.i++, this.script.length - 1)]!;
    return { generations: [{ message, text: "" }] };
  }
}

const agents: AgentCatalog = new Map([[
  "specialist",
  {
    id: "specialist",
    name: "specialist",
    description: "Handles delegated sends.",
    systemPrompt: "Send the mail.",
    source: "user",
    declaredTools: ["mcp:mailer:send"],
    skills: [],
    interruptOn: { "mcp:mailer:send": { allowedDecisions: ["approve", "reject"] } },
  },
]]);

describe("compiled GraphSpec protocol stream (offline)", () => {
  it("nests an agent node under its task namespace and resumes its approval pause", async () => {
    const checkpointer = new MemorySaver();
    const agent = await createPizzaBotAgent(PIZZA_BOT_AGENT.systemPrompt, {
      model: new ScriptedModel([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "task-1", name: "task", args: { description: "send", subagent_type: "specialist" }, type: "tool_call" }],
        }),
        new AIMessage({ content: "", tool_calls: [{ id: "send-1", name: "mailer__send", args: {}, type: "tool_call" }] }),
        new AIMessage({ content: "Sent." }),
        new AIMessage({ content: "Delegation completed." }),
      ]),
      tools: { "mcp:mailer:send": tool(() => "sent", { name: "mailer__send", description: "send", schema: z.object({}) }) },
      catalog: { mailer: ["send"] },
      agents,
      checkpointer,
    });
    const parsed = parseGraphSpec({
      id: "mail",
      name: "Mail",
      nodes: [{ id: "assistant", type: "agent", prompt: "Send {{input.body.what}}", output: "reply" }],
      edges: [{ from: "start", to: "assistant" }, { from: "assistant", to: "end" }],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const graph = compileGraphSpec(parsed.spec, {
      checkpointer,
      agentFor: async () => agent,
      modelFor: async () => { throw new Error("unused"); },
      tool: () => undefined,
    });
    const threadId = `graph_hitl_${Math.random().toString(36).slice(2)}`;

    const paused: ProtocolEvent[] = [];
    for await (const ev of graph.streamProtocol({ graphInput: { body: { what: "it" } } }, { threadId })) paused.push(ev);

    const started = paused.find(
      (e) => e.method === "lifecycle" && e.params.namespace.length === 1 &&
        (e.params.data as { event?: string }).event === "started",
    );
    expect(started?.params.namespace[0]).toMatch(/^assistant:/);
    // The pause bubbles through three graph levels but is requested once.
    const requested = paused.filter((e) => e.method === "input.requested");
    expect(requested).toHaveLength(1);
    expect(paused.at(-1)?.params.data).toMatchObject({ event: "interrupted" });

    const interruptId = (requested[0]!.params.data as { interrupt_id: string }).interrupt_id;
    for await (const _ of graph.streamProtocol(
      { command: { interruptId, decisions: [{ decision: "approve" }] } },
      { threadId },
    )) {
      // drain
    }
    const state = await graph.getState(threadId);
    expect(state.values).toMatchObject({ reply: "Delegation completed." });
    expect(state.next).toEqual([]);
  });
});
