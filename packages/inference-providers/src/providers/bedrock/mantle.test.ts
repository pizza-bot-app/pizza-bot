import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockLangChainModelProvider } from "./langchain.js";
import { createSigV4Fetch, mantleEndpoint } from "./mantle.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bedrock Mantle discovery", () => {
  it("unifies native and Mantle models under the Bedrock provider", async () => {
    const client = {
      send: vi.fn(async (command: unknown) =>
        command?.constructor.name === "ListInferenceProfilesCommand"
          ? { inferenceProfileSummaries: [] }
          : {
              modelSummaries: [{
                modelId: "amazon.nova-pro-v1:0",
                modelName: "Nova Pro",
                inputModalities: ["TEXT"],
              }],
            }),
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "openai.gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
        { id: "anthropic.claude-opus-5", display_name: "Claude Opus 5" },
      ],
    }), { status: 200 }));
    const provider = new BedrockLangChainModelProvider({
      region: "us-east-1",
      client,
      fetch: fetchFn,
    });
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key" },
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "amazon.nova-pro-v1:0",
        provider: "bedrock",
        displayName: "Nova Pro (Runtime)",
      }),
      expect.objectContaining({
        id: "openai.gpt-5.6-sol",
        provider: "bedrock",
        displayName: "GPT-5.6 Sol (Mantle)",
      }),
      expect.objectContaining({
        id: "anthropic.claude-opus-5",
        provider: "bedrock",
        displayName: "Claude Opus 5 (Mantle)",
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer bedrock-key" },
      }),
    );
  });

  it("keeps native capabilities when Mantle supplies the same model", async () => {
    const modelId = "openai.gpt-5.6-sol";
    const client = {
      send: vi.fn(async (command: unknown) =>
        command?.constructor.name === "ListInferenceProfilesCommand"
          ? { inferenceProfileSummaries: [] }
          : {
              modelSummaries: [{
                modelId,
                modelName: "GPT-5.6 Sol",
                inputModalities: ["TEXT", "IMAGE"],
              }],
            }),
    };
    const provider = new BedrockLangChainModelProvider({
      client,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        data: [{ id: modelId, display_name: "GPT-5.6 Sol" }],
      }), { status: 200 })),
      modelsDevFetch: vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 200 })),
    });
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key" },
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: modelId,
        displayName: "GPT-5.6 Sol (Mantle)",
        supportsTools: true,
        supportsVision: true,
      }),
    ]);
  });
});

describe("Bedrock Mantle invocation", () => {
  it("streams xAI models through the OpenAI-namespaced Responses endpoint", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      hasTool: boolean;
    }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "xai.grok-4.3", display_name: "Grok 4.3" }],
        }), { status: 200 });
      }
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        hasTool: String(init?.body).includes("lookup"),
      });
      return new Response(JSON.stringify({
        error: { message: "stop", type: "invalid_request_error" },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new BedrockLangChainModelProvider({
      region: "us-west-2",
      client: {
        send: vi.fn(async (command: unknown) =>
          command?.constructor.name === "ListInferenceProfilesCommand"
            ? { inferenceProfileSummaries: [] }
            : { modelSummaries: [] }),
      },
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 200 })),
    });
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key" },
    });
    await provider.listModels();

    const model = await provider.buildModel("xai.grok-4.3");
    await expect(collect(model.bindTools!([TEST_TOOL]).stream("hello")))
      .rejects.toThrow("stop");

    expect(requests).toEqual([{
      url: "https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses",
      authorization: "Bearer bedrock-key",
      hasTool: true,
    }]);
  });

  it("streams other model families through the regional Chat Completions endpoint", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      hasTool: boolean;
    }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "zai.glm-4.7-flash", display_name: "GLM 4.7 Flash" }],
        }), { status: 200 });
      }
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        hasTool: String(init?.body).includes("lookup"),
      });
      return new Response(JSON.stringify({
        error: { message: "stop", type: "invalid_request_error" },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new BedrockLangChainModelProvider({
      region: "eu-west-1",
      client: {
        send: vi.fn(async (command: unknown) =>
          command?.constructor.name === "ListInferenceProfilesCommand"
            ? { inferenceProfileSummaries: [] }
            : { modelSummaries: [] }),
      },
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 200 })),
    });
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key" },
    });
    await provider.listModels();

    const model = await provider.buildModel("zai.glm-4.7-flash");
    await expect(collect(model.bindTools!([TEST_TOOL]).stream("hello")))
      .rejects.toThrow("stop");

    expect(requests).toEqual([{
      url: "https://bedrock-mantle.eu-west-1.api.aws/v1/chat/completions",
      authorization: "Bearer bedrock-key",
      hasTool: true,
    }]);
  });

  it("streams OpenAI-family models through the regional Responses endpoint", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      hasTool: boolean;
    }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        hasTool: String(init?.body).includes("lookup"),
      });
      return eventStream([
        {
          type: "response.created",
          response: {
            id: "resp_1",
            model: "openai.future-model",
            status: "in_progress",
            output: [],
          },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            status: "in_progress",
            arguments: "",
            call_id: "call_1",
            name: "lookup",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: "{}",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            status: "completed",
            arguments: "{}",
            call_id: "call_1",
            name: "lookup",
          },
        },
      ]);
    });
    const provider = mantleProvider("openai.future-model", fetchFn);

    const model = await provider.buildModel("openai.future-model");
    const chunks = await collect(model.bindTools!([TEST_TOOL]).stream("hello"));
    const toolChunks = chunks.flatMap(
      (chunk) => (chunk as { tool_call_chunks?: Array<{ name?: string; args?: string }> })
        .tool_call_chunks ?? [],
    );

    expect(requests).toEqual([{
      url: "https://bedrock-mantle.eu-west-1.api.aws/openai/v1/responses",
      authorization: "Bearer bedrock-key",
      hasTool: true,
    }]);
    expect(toolChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "lookup" }),
      expect.objectContaining({ args: "{}" }),
    ]));
  });

  it("streams Anthropic-family models through the regional Messages endpoint", async () => {
    const requests: Array<{
      url: string;
      apiKey: string | null;
      hasTool: boolean;
    }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
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
            model: "anthropic.future-model",
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
    });
    const provider = mantleProvider("anthropic.future-model", fetchFn);

    const model = await provider.buildModel("anthropic.future-model");
    const chunks = await collect(model.bindTools!([TEST_TOOL]).stream("hello"));
    const toolChunks = chunks.flatMap(
      (chunk) => (chunk as { tool_call_chunks?: Array<{ name?: string; args?: string }> })
        .tool_call_chunks ?? [],
    );

    expect(requests).toEqual([{
      url: "https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages",
      apiKey: "bedrock-key",
      hasTool: true,
    }]);
    expect(toolChunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "lookup" }),
      expect.objectContaining({ args: "{}" }),
    ]));
  });

  it("signs Mantle requests when Bedrock uses AWS credentials", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    });
    const signedFetch = createSigV4Fetch(
      "us-west-2",
      {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: "session",
      },
      fetchFn,
    );

    await signedFetch(`${mantleEndpoint("us-west-2")}/v1/models?limit=1`, {
      headers: {
        authorization: "Bearer placeholder",
        "x-api-key": "placeholder",
      },
    });

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request,/,
    );
    expect(headers.get("x-amz-security-token")).toBe("session");
    expect(headers.get("x-api-key")).toBeNull();
  });
});

function mantleProvider(modelId: string, fetchFn: typeof fetch) {
  const provider = new BedrockLangChainModelProvider({
    region: "eu-west-1",
    fetch: fetchFn,
    models: [{
      id: modelId,
      provider: "bedrock",
      displayName: modelId,
    }],
  });
  provider.configure({
    method: "bedrock-api-key",
    values: { apiKey: "bedrock-key" },
  });
  return provider;
}

const TEST_TOOL = {
  type: "function" as const,
  function: {
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object", properties: {} },
  },
};

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
