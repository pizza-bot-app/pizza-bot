import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextOverflowError } from "@langchain/core/errors";
import { HumanMessage } from "@langchain/core/messages";
import {
  convertMessagesToCompletionsMessageParams,
  convertMessagesToResponsesInput,
} from "@langchain/openai";
import { isChatModel, OpenAiLangChainModelProvider, retryOutputCap } from "./openai.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAI model discovery", () => {
  it("lists chat models returned by the configured endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "gpt-5.6-terra" },
        { id: "text-embedding-3-large" },
        { id: "custom-chat-model" },
      ],
    }), { status: 200 }));
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://proxy.example/v1/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "gpt-5.6-terra", provider: "openai" }),
      expect.objectContaining({ id: "custom-chat-model", provider: "openai" }),
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://proxy.example/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("reports missing credentials without calling discovery", async () => {
    const fetchFn = vi.fn();
    const provider = new OpenAiLangChainModelProvider({ apiKey: "", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("excludes known non-chat model families", () => {
    expect(isChatModel("gpt-5")).toBe(true);
    expect(isChatModel("gpt-4o-search-preview")).toBe(true);
    expect(isChatModel("text-embedding-3-large")).toBe(false);
    expect(isChatModel("gpt-image-1")).toBe(false);
    expect(isChatModel("whisper-1")).toBe(false);
  });

  it("enriches discovered models from a provider-scoped models.dev catalog", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "alibaba/qwen-3-14b" }],
    }), { status: 200 }));
    const modelsDevFetch = vi.fn(async () => new Response(JSON.stringify({
      vercel: {
        models: {
          "alibaba/qwen-3-14b": {
            limit: { context: 40_960, output: 16_384 },
            tool_call: true,
            modalities: { input: ["text"] },
          },
        },
      },
    }), { status: 200 }));
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      fetch: fetchFn,
      modelsDevFetch,
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "alibaba/qwen-3-14b",
        contextWindow: 40_960,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsVision: false,
      }),
    ]);
    expect(modelsDevFetch).toHaveBeenCalledOnce();
  });

  it("replaces a cleared custom endpoint with the environment fallback", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://openai-fallback.example/v1");
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://openai-custom.example/v1",
      fetch: fetchFn,
    });

    provider.configure({
      method: "api-key",
      values: { apiKey: "test-key" },
    });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://openai-fallback.example/v1/models",
      expect.any(Object),
    );
  });
});

describe("OpenAI output token cap recovery", () => {
  it("uses an endpoint-reported max_total_tokens cap", () => {
    expect(retryOutputCap(
      new Error("max_tokens (8192) is greater than max_total_tokens: 4096"),
      8_192,
    )).toBe(4_096);
  });

  it("ignores unrelated and non-reducing errors", () => {
    expect(retryOutputCap(new Error("rate limit"), 8_192)).toBeUndefined();
    expect(retryOutputCap(new Error("max_tokens exceeds max_total_tokens=8192"), 4_096))
      .toBeUndefined();
  });
});

describe("OpenAI model construction", () => {
  it("does not require catalog discovery to succeed", async () => {
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    });

    await expect(provider.buildModel("private-deployment")).resolves.toBeDefined();
  });

  it("keeps catalog context windows model-specific", async () => {
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      models: [
        {
          id: "custom-chat-model",
          provider: "openai",
          displayName: "Custom Chat Model",
          contextWindow: 40_960,
        },
        {
          id: "small-chat-model",
          provider: "openai",
          displayName: "Small Chat Model",
          contextWindow: 16_384,
        },
      ],
    });

    const [custom, small] = await Promise.all([
      provider.buildModel("custom-chat-model"),
      provider.buildModel("small-chat-model"),
    ]);

    expect(custom.profile.maxInputTokens).toBe(40_960);
    expect(small.profile.maxInputTokens).toBe(16_384);
  });

  it("normalizes compatible endpoint context errors for summarization recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      openAiError(
        "request (43448 tokens) exceeds the available context size (32768 tokens)",
      ),
    ));
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://proxy.example/v1",
      apiMode: "chat-completions",
      models: [{
        id: "custom-chat-model",
        provider: "openai",
        displayName: "Custom Chat Model",
      }],
    });

    const model = await provider.buildModel("custom-chat-model");
    const failure = consume(model.stream("hello")).catch((error: unknown) => error);

    await expect(failure).resolves.toSatisfy((error: unknown) =>
      ContextOverflowError.isInstance(error),
    );
  });

  it("uses Responses for the configured API mode, including output-cap retries", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      hasTool: boolean;
    }> = [];
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        hasTool: String(init?.body).includes("lookup"),
      });
      requestCount += 1;
      const message = requestCount <= 2
        ? "max_tokens (8192) is greater than max_total_tokens: 4096"
        : "stop";
      return openAiError(message);
    }));
    const provider = new OpenAiLangChainModelProvider({
      models: [{
        id: "custom-responses-model",
        provider: "openai",
        displayName: "Custom Responses Model",
      }],
    });
    provider.configure({
      method: "api-key",
      values: {
        apiKey: "test-key",
        baseUrl: "https://proxy.example/openai/v1",
        apiMode: "responses",
      },
    });

    const model = await provider.buildModel("custom-responses-model");
    await expect(consume(model.bindTools!([TEST_TOOL]).stream("hello"))).rejects.toThrow("max_tokens");

    expect(requests).toEqual([
      {
        url: "https://proxy.example/openai/v1/responses",
        authorization: "Bearer test-key",
        hasTool: true,
      },
      {
        url: "https://proxy.example/openai/v1/responses",
        authorization: "Bearer test-key",
        hasTool: true,
      },
    ]);
  });

  it("can force Chat Completions for models LangChain would route to Responses", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return openAiError("stop");
    }));
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://proxy.example/v1",
      apiMode: "chat-completions",
      models: [{
        id: "gpt-5.5-pro",
        provider: "openai",
        displayName: "GPT-5.5 Pro",
      }],
    });

    const model = await provider.buildModel("gpt-5.5-pro");
    await expect(consume(model.bindTools!([TEST_TOOL]).stream("hello"))).rejects.toThrow("stop");

    expect(urls).toEqual(["https://proxy.example/v1/chat/completions"]);
  });

  it("exposes all supported API modes in provider settings", () => {
    const provider = new OpenAiLangChainModelProvider();
    const apiMode = provider.authSchema[0]?.fields.find((field) => field.key === "apiMode");

    expect(apiMode).toMatchObject({
      type: "select",
      default: "auto",
      options: [
        { value: "auto" },
        { value: "responses" },
        { value: "chat-completions" },
      ],
    });
  });
});

describe("OpenAI attachment conversion", () => {
  it("projects base64 images into native Responses input blocks", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAiLangChainModelProvider({
      fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return openAiError("stop");
      }),
      models: [{
        id: "responses-vision-model",
        provider: "openai",
        displayName: "Responses Vision Model",
      }],
    });
    provider.configure({
      method: "api-key",
      values: {
        apiKey: "test-key",
        baseUrl: "https://proxy.example/openai/v1",
        apiMode: "responses",
      },
    });
    const message = new HumanMessage({
      content: [
        { type: "text", text: "what is this?" },
        {
          type: "image",
          source_type: "base64",
          mime_type: "image/png",
          data: "QUJD",
        },
      ] as unknown as string,
    });

    const model = await provider.buildModel("responses-vision-model");
    await expect(consume(model.stream([message]))).rejects.toThrow("stop");

    expect(requestBody?.input).toEqual([{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,QUJD",
          detail: "auto",
        },
      ],
    }]);
  });

  it("preserves the original filename and extension in both request formats", () => {
    const filename = "✍️ Blogs Blog ideas.md";
    const message = new HumanMessage({
      content: [{
        type: "file",
        source_type: "base64",
        mime_type: "text/markdown",
        data: "IyBoaQ==",
        metadata: { name: filename },
      }] as unknown as string,
    });

    expect(convertMessagesToCompletionsMessageParams({
      messages: [message],
      model: "gpt-4o",
    })).toEqual([{
      role: "user",
      content: [{
        type: "file",
        file: {
          file_data: "data:text/markdown;base64,IyBoaQ==",
          filename,
        },
      }],
    }]);
    expect(convertMessagesToResponsesInput({
      messages: [message],
      model: "gpt-5",
      zdrEnabled: false,
    })).toEqual([{
      type: "message",
      role: "user",
      content: [{
        type: "input_file",
        file_data: "data:text/markdown;base64,IyBoaQ==",
        filename,
      }],
    }]);
  });
});

function openAiError(message: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: "invalid_request_error" },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

const TEST_TOOL = {
  type: "function" as const,
  function: {
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object", properties: {} },
  },
};

async function consume(stream: Promise<AsyncIterable<unknown>>): Promise<void> {
  for await (const _chunk of await stream) {
    // The test responses fail before producing a chunk.
  }
}
