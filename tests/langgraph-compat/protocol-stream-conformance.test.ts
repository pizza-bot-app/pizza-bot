/** Pins the real createDeepAgent -> streamEvents(v3) shapes consumed by the SDK. */
import { describe, it, expect } from "vitest";
import { createPizzaBotAgent } from "@pizza-bot/runtime-langgraph";
import { PIZZA_BOT_AGENT } from "@pizza-bot/core";
import type { RunInput, RunOptions, SkillCatalog, SkillInterruptOn } from "@pizza-bot/core";
import type { ProtocolEvent } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

class ScriptedModel extends BaseChatModel<Record<string, never>> {
  private i = 0;
  readonly boundToolSets: string[][] = [];
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType(): string {
    return "scripted-protocol-conformance";
  }
  override bindTools(tools: Array<{ name: string }>): this {
    this.boundToolSets.push(tools.map((item) => item.name));
    return this;
  }
  async _generate(): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const msg = this.script[Math.min(this.i, this.script.length - 1)]!;
    this.i++;
    return { generations: [{ message: msg, text: typeof msg.content === "string" ? msg.content : "" }] };
  }
}

async function collectProtocol(model: ScriptedModel): Promise<ProtocolEvent[]> {
  const agent = await createPizzaBotAgent(PIZZA_BOT_AGENT.systemPrompt, { model });
  const input: RunInput = { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] };
  const opts: RunOptions = { threadId: `proto_${Math.random().toString(36).slice(2)}` };
  const events: ProtocolEvent[] = [];
  for await (const ev of agent.streamProtocol(input, opts)) events.push(ev);
  return events;
}

const channelOf = (e: ProtocolEvent) => e.method;

function skillCatalog(
  id: string,
  description: string,
  body: string,
  declaredTools: string[],
  interruptOn: SkillInterruptOn = {},
): SkillCatalog {
  return new Map([[
    id,
    {
      id,
      name: id,
      description,
      source: "user",
      declaredTools,
      interruptOn,
      files: [{
        path: `/skills/${id}/SKILL.md`,
        content: `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`,
      }],
    },
  ]]);
}

describe("createPizzaBotAgent().streamProtocol() yields SDK-decodable ProtocolEvents (offline)", () => {
  it("every yield is a ProtocolEvent envelope with numeric seq + known method", async () => {
    const events = await collectProtocol(new ScriptedModel([new AIMessage({ content: "Hello there!" })]));
    expect(events.length).toBeGreaterThan(0);
    const KNOWN = new Set(["values", "updates", "messages", "tools", "lifecycle", "input.requested", "checkpoints", "tasks", "custom"]);
    for (const ev of events) {
      expect(ev.type).toBe("event");
      expect(typeof ev.seq).toBe("number");
      expect(KNOWN.has(String(ev.method))).toBe(true);
      expect(Array.isArray(ev.params.namespace)).toBe(true);
      expect(Array.isArray(ev as unknown)).toBe(false);
    }
  });

  it("a plain text turn reconstructs the assistant text from messages frames + closes with a root lifecycle", async () => {
    const events = await collectProtocol(new ScriptedModel([new AIMessage({ content: "Hello there!" })]));

    const text = events
      .filter((e) => channelOf(e) === "messages")
      .map((e) => {
        const d = e.params.data as { event?: string; delta?: { type?: string; text?: string } };
        return d?.event === "content-block-delta" && d.delta?.type === "text-delta" ? (d.delta.text ?? "") : "";
      })
      .join("");
    expect(text).toContain("Hello there!");

    const terminal = events.find((e) => {
      if (channelOf(e) !== "lifecycle" || e.params.namespace.length !== 0) return false;
      const d = e.params.data as { event?: string };
      return d?.event === "completed" || d?.event === "failed";
    });
    expect(terminal).toBeDefined();
  });

  it("the orchestrator's model tokens ride a NON-EMPTY model_request namespace", async () => {
    const events = await collectProtocol(new ScriptedModel([new AIMessage({ content: "hi" })]));
    const sawModelRequestNs = events.some(
      (e) => channelOf(e) === "messages" && typeof e.params.namespace[0] === "string" && e.params.namespace[0].startsWith("model_request:"),
    );
    expect(sawModelRequestNs).toBe(true);
    for (const e of events) {
      const first = e.params.namespace[0];
      if (channelOf(e) === "messages" && typeof first === "string") expect(first.startsWith("tools:")).toBe(false);
    }
  });

  it("does not expose the opt-in write_todos tool", async () => {
    const model = new ScriptedModel([new AIMessage({ content: "Done." })]);
    await collectProtocol(model);
    expect(model.boundToolSets.flat()).not.toContain("write_todos");
  });

  it("write_file surfaces natively on the tools channel AND values.files", async () => {
    const events = await collectProtocol(
      new ScriptedModel([
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "wf1",
            name: "write_file",
            args: { file_path: "/artifact.txt", content: "hello" },
            type: "tool_call",
          }],
        }),
        new AIMessage({ content: "Done." }),
      ]),
    );

    const toolFrames = events.filter((e) => channelOf(e) === "tools");
    expect(toolFrames.length).toBeGreaterThan(0);
    const toolBlob = JSON.stringify(toolFrames.map((e) => e.params.data));
    expect(toolBlob).toContain("write_file");

    const sawFile = events.some((e) => {
      if (channelOf(e) !== "values") return false;
      const files = (e.params.data as { files?: Record<string, unknown> })?.files;
      return files !== undefined && "/artifact.txt" in files;
    });
    expect(sawFile).toBe(true);
  });

  it("a thrown model error emits a ROOT-namespace lifecycle:failed frame before re-throwing", async () => {
    class ThrowingModel extends BaseChatModel<Record<string, never>> {
      _llmType() {
        return "throwing-protocol";
      }
      override bindTools(): this {
        return this;
      }
      async _generate(): Promise<never> {
        throw new Error("boom");
      }
    }
    const agent = await createPizzaBotAgent(
      PIZZA_BOT_AGENT.systemPrompt,
      { model: new ThrowingModel({}) },
    );
    const events: ProtocolEvent[] = [];
    let threw = false;
    try {
      for await (const ev of agent.streamProtocol(
        { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] },
        { threadId: `proto_err_${Math.random().toString(36).slice(2)}` },
      )) {
        events.push(ev);
      }
    } catch (err) {
      threw = true;
      expect(err instanceof Error ? err.message : String(err)).toContain("boom");
    }
    expect(threw).toBe(true);
    const failed = events.find((e) => {
      if (channelOf(e) !== "lifecycle" || e.params.namespace.length !== 0) return false;
      return (e.params.data as { event?: string }).event === "failed";
    });
    expect(failed).toBeDefined();
    expect((failed!.params.data as { error?: string }).error).toContain("boom");
  });

  it("a skill worker handles its own tool error before completing the delegated task", async () => {
    const boomTool = tool(
      () => {
        throw new Error("kaboom inside subagent");
      },
      { name: "boom", description: "always throws", schema: z.object({}) },
    );
    const agent = await createPizzaBotAgent(PIZZA_BOT_AGENT.systemPrompt, {
      model: new ScriptedModel([
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "task-1",
            name: "task",
            args: { description: "run the check", subagent_type: "specialist" },
            type: "tool_call",
          }],
        }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "boom-1", name: "boom", args: {}, type: "tool_call" }],
        }),
        new AIMessage({ content: "Subagent recovered." }),
        new AIMessage({ content: "Delegation completed." }),
      ]),
      tools: { "mcp:test:boom": boomTool },
      catalog: { test: ["boom"] },
      skills: skillCatalog(
        "specialist",
        "Handles delegated checks.",
        "Complete the delegated check.",
        ["mcp:test:boom"],
      ),
    });

    const events: ProtocolEvent[] = [];
    for await (const ev of agent.streamProtocol(
      { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "delegate" }] }] },
      { threadId: `proto_subagent_boom_${Math.random().toString(36).slice(2)}` },
    )) {
      events.push(ev);
    }

    const toolError = events.find(
      (e) =>
        channelOf(e) === "tools" &&
        (e.params.data as { event?: string; tool_call_id?: string }).event === "tool-error" &&
        (e.params.data as { tool_call_id?: string }).tool_call_id === "boom-1",
    );
    expect(toolError).toBeDefined();

    const text = events
      .filter((e) => channelOf(e) === "messages")
      .map((e) => {
        const d = e.params.data as { event?: string; delta?: { type?: string; text?: string } };
        return d?.event === "content-block-delta" && d.delta?.type === "text-delta" ? (d.delta.text ?? "") : "";
      })
      .join("");
    expect(text).toContain("Subagent recovered.");
    expect(text).toContain("Delegation completed.");
    expect(events.some(
      (e) =>
        channelOf(e) === "lifecycle" &&
        e.params.namespace.length === 0 &&
        (e.params.data as { event?: string }).event === "failed",
    )).toBe(false);
  });

  it("a worker's approval pause reports no error on the delegating task call", async () => {
    const sendTool = tool(() => "sent", {
      name: "mailer__send",
      description: "send mail",
      schema: z.object({}),
    });
    const skills = skillCatalog(
      "specialist",
      "Handles delegated sends.",
      "Send the mail.",
      ["mcp:mailer:send"],
      { "mcp:mailer:send": { allowedDecisions: ["approve", "reject"] } },
    );
    const agent = await createPizzaBotAgent(PIZZA_BOT_AGENT.systemPrompt, {
      model: new ScriptedModel([
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "task-1",
            name: "task",
            args: { description: "send the mail", subagent_type: "specialist" },
            type: "tool_call",
          }],
        }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "send-1", name: "mailer__send", args: {}, type: "tool_call" }],
        }),
        new AIMessage({ content: "Sent." }),
        new AIMessage({ content: "Delegation completed." }),
      ]),
      tools: { "mcp:mailer:send": sendTool },
      catalog: { mailer: ["send"] },
      skills,
      checkpointer: new MemorySaver(),
    });

    const threadId = `proto_subagent_hitl_${Math.random().toString(36).slice(2)}`;
    const paused: ProtocolEvent[] = [];
    for await (const ev of agent.streamProtocol(
      { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] }] },
      { threadId },
    )) {
      paused.push(ev);
    }

    const toolErrors = paused.filter(
      (e) => channelOf(e) === "tools" && (e.params.data as { event?: string }).event === "tool-error",
    );
    expect(toolErrors).toEqual([]);
    const requested = paused.find((e) => channelOf(e) === "input.requested");
    expect(requested).toBeDefined();
    const interruptId = (requested!.params.data as { interrupt_id: string }).interrupt_id;
    expect(paused.some(
      (e) =>
        channelOf(e) === "lifecycle" &&
        (e.params.data as { event?: string }).event === "interrupted",
    )).toBe(true);

    // Approving finishes the same task call, so the delegation reads as completed.
    const resumed: ProtocolEvent[] = [];
    for await (const ev of agent.streamProtocol(
      { command: { interruptId, decisions: [{ decision: "approve" }] } },
      { threadId },
    )) {
      resumed.push(ev);
    }
    expect(resumed.some(
      (e) =>
        channelOf(e) === "tools" &&
        (e.params.data as { event?: string; tool_call_id?: string }).event === "tool-finished" &&
        (e.params.data as { tool_call_id?: string }).tool_call_id === "task-1",
    )).toBe(true);
    expect(resumed.some(
      (e) => channelOf(e) === "tools" && (e.params.data as { event?: string }).event === "tool-error",
    )).toBe(false);
  });

  it("a skill worker can receive an MCP tool whose original name is reserved", async () => {
    const externalReadFile = tool(
      () => "external file",
      {
        name: "filesystem-mcp-server__read_file",
        description: "read an external file",
        schema: z.object({}),
      },
    );
    const model = new ScriptedModel([
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "task-reserved-1",
            name: "task",
            args: { description: "run the check", subagent_type: "specialist" },
            type: "tool_call",
          }],
        }),
        new AIMessage({ content: "Subagent completed." }),
        new AIMessage({ content: "Delegation completed." }),
      ]);
    const agent = await createPizzaBotAgent(PIZZA_BOT_AGENT.systemPrompt, {
      model,
      tools: { "mcp:filesystem-mcp-server:read_file": externalReadFile },
      catalog: { "filesystem-mcp-server": ["read_file"] },
      skills: skillCatalog(
        "specialist",
        "Handles delegated checks.",
        "Complete the delegated check.",
        ["mcp:filesystem-mcp-server:read_file"],
      ),
    });

    const events: ProtocolEvent[] = [];
    for await (const ev of agent.streamProtocol(
      { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "delegate" }] }] },
      { threadId: `proto_subagent_reserved_${Math.random().toString(36).slice(2)}` },
    )) {
      events.push(ev);
    }

    const text = events
      .filter((e) => channelOf(e) === "messages")
      .map((e) => {
        const d = e.params.data as { event?: string; delta?: { type?: string; text?: string } };
        return d?.event === "content-block-delta" && d.delta?.type === "text-delta" ? (d.delta.text ?? "") : "";
      })
      .join("");
    expect(text).toContain("Subagent completed.");
    expect(text).toContain("Delegation completed.");
    expect(model.boundToolSets.some((tools) =>
      tools.includes("filesystem-mcp-server__read_file") &&
      tools.includes("read_file")
    )).toBe(true);
    expect(events.some(
      (e) =>
        channelOf(e) === "lifecycle" &&
        e.params.namespace.length === 0 &&
        (e.params.data as { event?: string }).event === "failed",
    )).toBe(false);
  });
});
