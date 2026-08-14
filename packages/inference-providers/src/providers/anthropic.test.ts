import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicLangChainModelProvider, normalizeBaseUrl } from "./anthropic.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic model discovery", () => {
  it("lists models returned by Anthropic", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      ],
    }), { status: 200 }));
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.example/",
      catalogProvider: "anthropic-compatible",
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        "anthropic-compatible": {
          models: {
            "claude-sonnet-5": {
              limit: { context: 1_000_000, output: 128_000 },
            },
          },
        },
      }), { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5 (Anthropic)",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      }),
      expect.objectContaining({
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5 (Anthropic)",
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://anthropic.example/v1/models?limit=1000",
      expect.objectContaining({
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-key",
        },
      }),
    );
  });

  it("reports authentication failures", async () => {
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "authentication",
      retryable: false,
    });
  });

});

describe("Anthropic model construction", () => {
  it("discovers and projects catalog context while retaining native capabilities", async () => {
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
      }), { status: 200 })),
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        anthropic: {
          models: {
            "claude-sonnet-5": {
              limit: { context: 750_000 },
            },
          },
        },
      }), { status: 200 })),
    });

    const model = await provider.buildModel("claude-sonnet-5");

    expect(model.profile).toMatchObject({
      maxInputTokens: 750_000,
      imageInputs: true,
      toolCalling: true,
    });
  });

  it("streams tool calls through a custom Messages endpoint", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      apiKey: string | null;
      hasTool: boolean;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
        hasTool: String(init?.body).includes("lookup"),
      });
      return eventStream([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "anthropic.claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ]);
    }));
    const provider = new AnthropicLangChainModelProvider({
      models: [{
        id: "anthropic.claude-opus-5",
        provider: "anthropic",
        displayName: "Claude Opus 5",
      }],
    });
    provider.configure({
      method: "api-key",
      values: {
        apiKey: "test-key",
        baseUrl: "https://proxy.example/anthropic",
        authMode: "api-key",
      },
    });

    const model = await provider.buildModel("anthropic.claude-opus-5");
    const chunks = await collect(model.bindTools!([TEST_TOOL]).stream("hello"));
    const toolChunks = chunks.flatMap(
      (chunk) => (chunk as { tool_call_chunks?: Array<{ name?: string; args?: string }> })
        .tool_call_chunks ?? [],
    );

    expect(requests).toEqual([{
      url: "https://proxy.example/anthropic/v1/messages",
      authorization: null,
      apiKey: "test-key",
      hasTool: true,
    }]);
    expect(toolChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "lookup" }),
      expect.objectContaining({ args: "{}" }),
    ]));
  });

  it("supports bearer authentication with a custom Messages URL", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      apiKey: string | null;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
      });
      return anthropicError("stop");
    }));
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://proxy.example/anthropic/v1/messages",
      authMode: "bearer",
      models: [{
        id: "anthropic.claude-opus-5",
        provider: "anthropic",
        displayName: "Claude Opus 5",
      }],
    });

    const model = await provider.buildModel("anthropic.claude-opus-5");
    await expect(collect(model.stream("hello"))).rejects.toThrow("stop");

    expect(requests).toEqual([{
      url: "https://proxy.example/anthropic/v1/messages",
      authorization: "Bearer test-key",
      apiKey: null,
    }]);
  });

  it("exposes custom endpoint metadata and bearer authentication in provider settings", () => {
    const provider = new AnthropicLangChainModelProvider();
    const fields = provider.authSchema[0]?.fields;

    expect(fields?.find((field) => field.key === "baseUrl")).toMatchObject({
      type: "text",
      required: false,
    });
    expect(fields?.find((field) => field.key === "authMode")).toMatchObject({
      type: "select",
      default: "api-key",
      options: [
        { value: "api-key" },
        { value: "bearer" },
      ],
    });
    expect(fields?.find((field) => field.key === "catalogProvider")).toMatchObject({
      label: "models.dev provider",
      type: "text",
      required: false,
    });
  });
});

describe("Anthropic endpoint normalization", () => {
  it("accepts either an API base URL or a full Messages URL", () => {
    expect(normalizeBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com");
    expect(normalizeBaseUrl(
      "https://proxy.example/anthropic/v1/messages",
    )).toBe("https://proxy.example/anthropic");
  });
});

const TEST_TOOL = {
  type: "function" as const,
  function: {
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object", properties: {} },
  },
};

function anthropicError(message: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: "invalid_request_error" },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

async function collect<T>(stream: Promise<AsyncIterable<T>>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of await stream) chunks.push(chunk);
  return chunks;
}

function eventStream(events: Array<{ type: string } & Record<string, unknown>>): Response {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
