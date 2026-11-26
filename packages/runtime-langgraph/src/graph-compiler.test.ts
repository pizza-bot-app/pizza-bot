import { describe, expect, it } from "vitest";
import { MemorySaver, type ProtocolEvent } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parseGraphSpec, type GraphSpec, type RunInput } from "@pizza-bot/core";
import { compileGraphSpec, type GraphRuntimeDeps } from "./graph-compiler.js";

class EchoModel extends BaseChatModel<Record<string, never>> {
  readonly prompts: string[] = [];
  _llmType(): string {
    return "echo";
  }
  async _generate(messages: Array<{ content: unknown }>) {
    const text = String(messages.at(-1)?.content ?? "");
    this.prompts.push(text);
    const message = new AIMessage({ content: `echo:${text}` });
    return { generations: [{ message, text: message.content as string }] };
  }
}

function spec(raw: unknown): GraphSpec {
  const parsed = parseGraphSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
}

const triage = spec({
  id: "triage",
  name: "Triage",
  nodes: [
    { id: "prep", type: "transform", set: { who: "{{input.body.user}}", n: "{{input.body.n}}" } },
    { id: "lookup", type: "tool", tool: "mcp:crm:lookup", args: { user: "{{who}}" }, output: "account" },
    {
      id: "route",
      type: "branch",
      cases: [{ when: { path: "account.tier", op: "eq", value: "gold" }, to: "ask" }],
      default: "summarize",
    },
    { id: "ask", type: "human", prompt: "Escalate {{who}}?", output: "decision" },
    { id: "summarize", type: "llm", prompt: "Summarize {{who}} {{decision}}", output: "summary" },
  ],
  edges: [
    { from: "start", to: "prep" },
    { from: "prep", to: "lookup" },
    { from: "lookup", to: "route" },
    { from: "ask", to: "summarize" },
    { from: "summarize", to: "end" },
  ],
});

function harness(tier: string) {
  const model = new EchoModel({});
  const lookups: unknown[] = [];
  const lookup = tool(
    async (args) => {
      lookups.push(args);
      return JSON.stringify({ tier });
    },
    { name: "crm__lookup", description: "lookup", schema: z.object({ user: z.string() }) },
  );
  const deps: GraphRuntimeDeps = {
    checkpointer: new MemorySaver(),
    agentFor: async () => ({ runAsNode: async (prompt) => `agent:${prompt}` }),
    modelFor: async () => model,
    tool: (ref) => (ref === "mcp:crm:lookup" ? lookup : undefined),
  };
  const graph = compileGraphSpec(triage, deps);
  const threadId = `graph_${Math.random().toString(36).slice(2)}`;
  const run = async (input: RunInput) => {
    const events: ProtocolEvent[] = [];
    for await (const ev of graph.streamProtocol(input, { threadId })) events.push(ev);
    return events;
  };
  return { graph, model, lookups, threadId, run };
}

const finishedNodes = (events: ProtocolEvent[]) =>
  events
    .filter((e) => e.method === "tasks" && e.params.namespace.length === 0)
    .map((e) => e.params.data as { name: string; result?: unknown })
    .filter((d) => "result" in d)
    .map((d) => d.name);

describe("compileGraphSpec", () => {
  it("runs a deterministic path with templated tool args and reports each node on the tasks channel", async () => {
    const h = harness("silver");
    const events = await h.run({ graphInput: { body: { user: "ada", n: 2 } } });

    expect(finishedNodes(events)).toEqual(["prep", "lookup", "route", "summarize"]);
    expect(h.lookups).toEqual([{ user: "ada" }]);
    const state = await h.graph.getState(h.threadId);
    expect(state.values).toMatchObject({
      input: { body: { user: "ada", n: 2 } },
      who: "ada",
      n: 2,
      account: { tier: "silver" },
      summary: "echo:Summarize ada ",
    });
  });

  it("pauses at a human node, continues from the checkpoint, and resumes with the response", async () => {
    const h = harness("gold");
    const paused = await h.run({ graphInput: { body: { user: "bo" } } });
    const requested = paused.filter((e) => e.method === "input.requested");
    expect(requested).toHaveLength(1);
    const data = requested[0]!.params.data as { interrupt_id: string; payload: unknown };
    expect(data.payload).toEqual({ type: "graph.human", nodeId: "ask", prompt: "Escalate bo?" });

    // A crashed or cancelled run continues where the checkpoint left off.
    const continued = await h.run({ graphInput: { body: { user: "bo" } }, continueFromCheckpoint: true });
    expect(continued.some((e) => e.method === "input.requested")).toBe(true);
    expect(h.lookups).toHaveLength(1);

    await expect(h.run({ command: { interruptId: data.interrupt_id, decisions: [{ decision: "approve" }] } }))
      .rejects.toThrow("takes a response, not an approval decision");
    await expect(h.run({ command: { interruptId: "bogus", decisions: [{ decision: "approve" }] } }))
      .rejects.toThrow("No pending step has interrupt id bogus");
    await expect(h.run({ command: { interruptId: "bogus", response: "yes" } }))
      .rejects.toThrow("No pending step has interrupt id bogus");
    expect((await h.graph.getState(h.threadId)).next).toEqual(["ask"]);

    const resumed = await h.run({ command: { interruptId: data.interrupt_id, response: "yes" } });
    expect(finishedNodes(resumed)).toEqual(["ask", "summarize"]);
    const state = await h.graph.getState(h.threadId);
    expect(state.values).toMatchObject({ decision: "yes", summary: "echo:Summarize bo yes" });
    expect(state.next).toEqual([]);
  });

  it("starts from the seed when asked to continue a thread that has no checkpoint", async () => {
    const h = harness("silver");
    const events = await h.run({ graphInput: { body: { user: "cy" } }, continueFromCheckpoint: true });
    expect(finishedNodes(events)).toEqual(["prep", "lookup", "route", "summarize"]);
    expect(h.lookups).toEqual([{ user: "cy" }]);
  });

  it("fails the run when a tool node's tool is not connected", async () => {
    const graph = compileGraphSpec(
      spec({
        id: "broken",
        name: "Broken",
        nodes: [{ id: "call", type: "tool", tool: "mcp:gone:x", output: "out" }],
        edges: [{ from: "start", to: "call" }, { from: "call", to: "end" }],
      }),
      {
        agentFor: async () => ({ runAsNode: async () => "" }),
        modelFor: async () => new EchoModel({}),
        tool: () => undefined,
      },
    );
    const drain = async () => {
      for await (const _ of graph.streamProtocol({ graphInput: {} }, { threadId: "broken" })) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow("Tool mcp:gone:x is not connected.");
  });

  it("runs the agent an agent node names, on the node's model", async () => {
    const asked: Array<[string | undefined, string | undefined]> = [];
    const graph = compileGraphSpec(
      spec({
        id: "named",
        name: "Named",
        nodes: [{ id: "research", type: "agent", prompt: "Find fares", agentId: "researcher", model: "m1", output: "found" }],
        edges: [{ from: "start", to: "research" }, { from: "research", to: "end" }],
      }),
      {
        checkpointer: new MemorySaver(),
        agentFor: async (modelId, agentId) => {
          asked.push([modelId, agentId]);
          return { runAsNode: async (prompt) => `${agentId}:${prompt}` };
        },
        modelFor: async () => new EchoModel({}),
        tool: () => undefined,
      },
    );
    for await (const _ of graph.streamProtocol({ graphInput: {} }, { threadId: "named" })) {
      // drain
    }
    expect(asked).toEqual([["m1", "researcher"]]);
    expect((await graph.getState("named")).values).toMatchObject({ found: "researcher:Find fares" });
  });
});

