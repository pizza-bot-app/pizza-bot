import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { describe, expect, it } from "vitest";
import {
  buildToolArgNames,
  coerceStringifiedToolArgs,
  coerceStringifiedToolArgsEvent,
  coerceOllamaMessageContent,
} from "./ollama-tool-call-fix.js";
import { OllamaLangChainModelProvider } from "./ollama.js";

const TASK_TOOL = {
  type: "function",
  function: {
    name: "task",
    description: "Delegate a task",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["description", "subagent_type"],
    },
  },
} as const;

describe("coerceStringifiedToolArgs", () => {
  it("parses stringified arrays and objects in tool call arguments", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "1",
          name: "write_todos",
          args: {
            todos: '[{"content":"test","status":"pending"}]',
            metadata: '{"source":"local"}',
          },
          type: "tool_call",
        },
      ],
    });

    coerceStringifiedToolArgs(message);

    expect(message.tool_calls?.[0]?.args).toEqual({
      todos: [{ content: "test", status: "pending" }],
      metadata: { source: "local" },
    });
  });

  it("leaves primitive and malformed string arguments untouched", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "1",
          name: "send",
          args: { message: "hello", count: "42", quoted: '"hello"', invalid: "[}" },
          type: "tool_call",
        },
      ],
    });

    coerceStringifiedToolArgs(message);

    expect(message.tool_calls?.[0]?.args).toEqual({
      message: "hello",
      count: "42",
      quoted: '"hello"',
      invalid: "[}",
    });
  });

  it("maps generated argument casing to declared schema property names", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "1",
          name: "task",
          args: {
            description: "Check unread email",
            subagentType: "communications-assistant",
          },
          type: "tool_call",
        },
      ],
    });

    coerceStringifiedToolArgs(message, buildToolArgNames([TASK_TOOL]));

    expect(message.tool_calls?.[0]?.args).toEqual({
      description: "Check unread email",
      subagent_type: "communications-assistant",
    });
  });

  it("does not overwrite canonical or ambiguously matched arguments", () => {
    const schemas = buildToolArgNames([{
      type: "function",
      function: {
        name: "ambiguous",
        parameters: {
          type: "object",
          properties: {
            agent_type: { type: "string" },
            agenttype: { type: "string" },
          },
        },
      },
    }]);
    const message = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "1",
          name: "ambiguous",
          args: {
            agentType: "unchanged",
            agent_type: "canonical",
          },
          type: "tool_call",
        },
      ],
    });

    coerceStringifiedToolArgs(message, schemas);

    expect(message.tool_calls?.[0]?.args).toEqual({
      agentType: "unchanged",
      agent_type: "canonical",
    });
  });

  it("normalizes schema keys on the v3 content-block event path", () => {
    const event = coerceStringifiedToolArgsEvent(
      {
        event: "content-block-finish",
        index: 0,
        content: {
          type: "tool_call",
          name: "task",
          args: {
            description: "Check unread email",
            subagentType: "communications-assistant",
          },
        },
      },
      buildToolArgNames([TASK_TOOL]),
    );

    expect(
      event.event === "content-block-finish"
        ? event.content.args
        : undefined,
    ).toEqual({
      description: "Check unread email",
      subagent_type: "communications-assistant",
    });
  });

  it("coerces structured fields inside streaming tool call chunks", () => {
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        {
          name: "write_todos",
          args: JSON.stringify({ todos: '[{"content":"test"}]' }),
          type: "tool_call_chunk",
          index: 0,
        },
      ],
    });

    coerceStringifiedToolArgs(chunk);

    expect(JSON.parse(chunk.tool_call_chunks?.[0]?.args ?? "")).toEqual({
      todos: [{ content: "test" }],
    });
  });

  it("ignores empty and incomplete streaming arguments", () => {
    const chunk = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        { name: "first", args: "", type: "tool_call_chunk", index: 0 },
        { name: "second", args: '{"todos":', type: "tool_call_chunk", index: 1 },
      ],
    });

    expect(() => coerceStringifiedToolArgs(chunk)).not.toThrow();
    expect(chunk.tool_call_chunks?.map((call) => call.args)).toEqual(["", '{"todos":']);
  });
});

describe("coerceOllamaMessageContent", () => {
  it("flattens text blocks without mutating checkpointed messages", () => {
    const toolMessage = new ToolMessage({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      tool_call_id: "call_1",
      name: "read_file",
    });

    const rewritten = coerceOllamaMessageContent([
      new HumanMessage("go"),
      toolMessage,
    ]);

    expect(rewritten[1]?.content).toBe("first\nsecond");
    expect(toolMessage.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("serializes non-text blocks for Ollama's string-only tool role", () => {
    const toolMessage = new ToolMessage({
      content: [{ type: "image", mimeType: "image/png", data: "abc" }],
      tool_call_id: "call_1",
      name: "read_file",
    });

    const rewritten = coerceOllamaMessageContent([toolMessage]);

    expect(rewritten[0]?.content).toBe(
      '[{"type":"image","mimeType":"image/png","data":"abc"}]',
    );
  });
});

interface OllamaChatChunk {
  message: {
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

// Stubs the Ollama daemon so `streamEvents(v3)` — which dispatches through
// `_streamChatModelEvents`, not `_streamResponseChunks` — can be exercised
// against a real `ChatOllama` subclass without a running daemon.
function stubOllamaClient(
  model: unknown,
  chunks: OllamaChatChunk[],
  onChat?: (messages: unknown) => void,
): void {
  (model as { client: unknown }).client = {
    async chat(request: { messages?: unknown }) {
      onChat?.(request.messages);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
    abort() {},
  };
}

describe("Ollama v3 streaming tool-arg coercion", () => {
  it("aborts a stalled Ollama HTTP stream without waiting for another chunk", async () => {
    let resolveChatStarted!: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      resolveChatStarted = resolve;
    });
    let chatSignal: AbortSignal | null | undefined;
    const provider = new OllamaLangChainModelProvider({
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).endsWith("/api/show")) {
          return new Response(null, { status: 404 });
        }
        chatSignal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            resolveChatStarted();
            chatSignal?.addEventListener(
              "abort",
              () => controller.error(chatSignal?.reason),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }) as typeof fetch,
    });
    const model = await provider.buildModel("test-model");
    const abort = new AbortController();
    const consuming = (async () => {
      for await (const _event of model.streamEvents(
        [new HumanMessage("wait")],
        { signal: abort.signal },
      )) {
        // The fake daemon deliberately never emits a complete chunk.
      }
    })();

    await chatStarted;
    abort.abort();

    await expect(Promise.race([
      consuming.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("settled");
    expect(chatSignal?.aborted).toBe(true);
  });

  it("normalizes response argument names against bound tool schemas", async () => {
    const model = await new OllamaLangChainModelProvider().buildModel("test-model");
    stubOllamaClient(model, [
      {
        message: {
          content: "",
          tool_calls: [{
            function: {
              name: "task",
              arguments: {
                description: "Check unread email",
                subagentType: "communications-assistant",
              },
            },
          }],
        },
      },
      { message: { content: "" }, done: true, done_reason: "stop" },
    ]);
    if (!model.bindTools) throw new Error("Expected Ollama tool binding support");

    const response = await model.bindTools([TASK_TOOL]).invoke([
      new HumanMessage("delegate"),
    ]);

    expect(response.tool_calls?.[0]?.args).toEqual({
      description: "Check unread email",
      subagent_type: "communications-assistant",
    });
  });

  it("sends structured text tool results as strings on the next model call", async () => {
    const model = await new OllamaLangChainModelProvider().buildModel("test-model");
    let sentMessages: unknown;
    stubOllamaClient(
      model,
      [{ message: { content: "complete" }, done: true, done_reason: "stop" }],
      (messages) => {
        sentMessages = messages;
      },
    );
    const toolResult = new ToolMessage({
      content: [{ type: "text", text: " 1\tSkill instructions" }],
      tool_call_id: "call_1",
      name: "read_file",
    });

    await expect(model.invoke([
      new HumanMessage("go"),
      new AIMessage({
        content: "",
        tool_calls: [{
          id: "call_1",
          name: "read_file",
          args: { file_path: "/skills/email/SKILL.md" },
          type: "tool_call",
        }],
      }),
      toolResult,
    ])).resolves.toBeInstanceOf(AIMessage);

    expect(sentMessages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: { file_path: "/skills/email/SKILL.md" },
          },
        }],
      },
      { role: "tool", content: " 1\tSkill instructions" },
    ]);
    expect(toolResult.content).toEqual([
      { type: "text", text: " 1\tSkill instructions" },
    ]);
  });

  it("replays v3 tool-call blocks as an assistant tool call, without reasoning", async () => {
    const model = await new OllamaLangChainModelProvider({
      fetch: async () => new Response(null, { status: 404 }),
    }).buildModel("test-model");
    let sentMessages: unknown;
    stubOllamaClient(
      model,
      [{ message: { content: "complete" }, done: true, done_reason: "stop" }],
      (messages) => {
        sentMessages = messages;
      },
    );
    const checkpointedCall = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "Call the tool." },
        {
          type: "tool_call",
          id: "call_1",
          name: "read_file",
          args: { file_path: "/skills/email/SKILL.md" },
        },
      ] as unknown as string,
      tool_calls: [{
        id: "call_1",
        name: "read_file",
        args: { file_path: "/skills/email/SKILL.md" },
        type: "tool_call",
      }],
    });

    await model.invoke([
      new HumanMessage("go"),
      checkpointedCall,
      new ToolMessage({
        content: "Skill instructions",
        tool_call_id: "call_1",
        name: "read_file",
      }),
    ]);

    expect(sentMessages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: { file_path: "/skills/email/SKILL.md" },
          },
        }],
      },
      { role: "tool", content: "Skill instructions" },
    ]);
    expect(checkpointedCall.content).toHaveLength(2);
  });

  it("coerces args and assigns an ID that survives the next model turn", async () => {
    const model = await new OllamaLangChainModelProvider().buildModel("test-model");
    stubOllamaClient(model, [
      {
        message: {
          content: "",
          tool_calls: [
            { function: { name: "write_todos", arguments: { todos: '[{"content":"a"}]' } } },
          ],
        },
      },
      { message: { content: "" }, done: true, done_reason: "stop" },
    ]);

    // No `version` option is the v3 content-block stream that DeepAgents/LangGraph
    // drives in production, dispatching through `_streamChatModelEvents`.
    const stream = model.streamEvents([new HumanMessage("go")]);
    const events: ChatModelStreamEvent[] = [];
    for await (const event of stream) events.push(event);

    const finish = events.find(
      (e): e is Extract<ChatModelStreamEvent, { event: "content-block-finish" }> =>
        e.event === "content-block-finish" && e.content.type === "tool_call",
    );
    expect(finish).toBeDefined();
    const finishedArgs = (finish?.content as unknown as { args: unknown }).args;
    expect(finishedArgs).toEqual({ todos: [{ content: "a" }] });
    expect(finish?.content.id).toEqual(expect.any(String));
    const streamedIds = events.flatMap((event) => {
      if (
        event.event === "content-block-start" &&
        event.content.type === "tool_call_chunk"
      ) return [event.content.id];
      if (
        event.event === "content-block-delta" &&
        event.delta.type === "block-delta" &&
        event.delta.fields.type === "tool_call_chunk"
      ) return [event.delta.fields.id];
      if (
        event.event === "content-block-finish" &&
        event.content.type === "tool_call"
      ) return [event.content.id];
      return [];
    });
    expect(streamedIds).toEqual([
      finish?.content.id,
      finish?.content.id,
      finish?.content.id,
    ]);

    const response = await stream;
    const toolCall = response.tool_calls?.[0];
    expect(toolCall?.id).toBe(finish?.content.id);
    if (!toolCall?.id) throw new Error("Expected Ollama tool call ID");

    const toolResult = new ToolMessage({
      name: "write_todos",
      content: "done",
      tool_call_id: toolCall.id,
    });
    stubOllamaClient(model, [
      { message: { content: "complete" }, done: true, done_reason: "stop" },
    ]);

    // Checkpoint hydration can leave a message-shaped object rather than the
    // original class instance. A missing tool_call_id fails LangChain coercion.
    const hydratedToolResult = { ...toolResult };
    await expect(model.invoke([
      new HumanMessage("go"),
      response,
      hydratedToolResult,
    ])).resolves.toBeInstanceOf(AIMessage);
  });
});

describe("Ollama model capabilities", () => {
  it("enables supported thinking and exposes the effective context profile", async () => {
    const provider = new OllamaLangChainModelProvider({
      contextLength: 65_536,
      fetch: async () => Response.json({
        capabilities: ["completion", "tools", "thinking"],
        model_info: {
          "general.architecture": "gemma4",
          "gemma4.context_length": 131_072,
        },
      }),
    });

    const model = await provider.buildModel("gemma4:latest") as BaseChatModel & {
      numCtx?: number;
      think?: boolean;
    };

    expect(model.numCtx).toBe(65_536);
    expect(model.think).toBe(true);
    expect(model.profile).toMatchObject({
      maxInputTokens: 65_536,
      reasoningOutput: true,
      toolCalling: true,
    });
  });

  it("clamps context to the model limit and honors disabled thinking", async () => {
    const provider = new OllamaLangChainModelProvider({
      contextLength: 32_768,
      thinking: "disabled",
      fetch: async () => Response.json({
        capabilities: ["completion", "tools", "thinking"],
        model_info: { "small.context_length": 8_192 },
      }),
    });

    const model = await provider.buildModel("small") as BaseChatModel & {
      numCtx?: number;
      think?: boolean;
    };

    expect(model.numCtx).toBe(8_192);
    expect(model.think).toBe(false);
    expect(model.profile.maxInputTokens).toBe(8_192);
  });
});
