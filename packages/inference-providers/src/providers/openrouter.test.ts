import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { OpenRouterLangChainModelProvider } from "./openrouter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter model discovery", () => {
  it("maps the native catalog to model descriptors", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: "anthropic/claude-sonnet-4.5",
          name: "Anthropic: Claude Sonnet 4.5",
          context_length: 200_000,
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
          top_provider: { max_completion_tokens: 64_000 },
          supported_parameters: ["max_tokens", "tools"],
        },
        {
          id: "openai/image-model",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["image"],
          },
        },
      ],
    }), { status: 200 }));
    const provider = new OpenRouterLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://openrouter.example/api/v1/",
      siteUrl: "https://pizza.example",
      siteName: "Pizza Bot Test",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        displayName: "Anthropic: Claude Sonnet 4.5 (OpenRouter)",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.example/api/v1/models",
      expect.objectContaining({
        headers: {
          authorization: "Bearer test-key",
          "http-referer": "https://pizza.example",
          "x-title": "Pizza Bot Test",
        },
      }),
    );
  });

  it("reports missing credentials without calling discovery", async () => {
    const fetchFn = vi.fn();
    const provider = new OpenRouterLangChainModelProvider({ apiKey: "", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fills missing native metadata from the OpenRouter models.dev catalog", async () => {
    const provider = new OpenRouterLangChainModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        data: [{
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5",
        }],
      }), { status: 200 })),
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        openrouter: {
          models: {
            "anthropic/claude-sonnet-5": {
              limit: { context: 1_000_000, output: 128_000 },
              tool_call: true,
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      }), { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "anthropic/claude-sonnet-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
      }),
    ]);
  });
});

describe("OpenRouter model construction", () => {
  it("builds the native LangChain model with the configured output cap", async () => {
    const provider = new OpenRouterLangChainModelProvider({
      apiKey: "test-key",
      maxTokens: 32_000,
      siteName: "Pizza Bot Test",
      models: [{
        id: "anthropic/claude-sonnet-4.5",
        provider: "openrouter",
        displayName: "Claude Sonnet 4.5 (OpenRouter)",
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      }],
    });

    const model = await provider.buildModel("anthropic/claude-sonnet-4.5");

    expect(model).toMatchObject({
      model: "anthropic/claude-sonnet-4.5",
      apiKey: "test-key",
      maxTokens: 16_000,
      siteName: "Pizza Bot Test",
    });
    expect(model._llmType()).toBe("openrouter");
    expect(model.profile.maxInputTokens).toBe(200_000);
  });

  it("classifies a missing API key as expired authentication", async () => {
    const provider = new OpenRouterLangChainModelProvider({ apiKey: "" });

    await expect(provider.buildModel("openai/gpt-4o")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });
});

describe("OpenRouter attachment conversion", () => {
  it("preserves the original filename and extension in the request body", async () => {
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({
      id: "generation-1",
      model: "openai/gpt-4o",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchFn);
    const provider = new OpenRouterLangChainModelProvider({
      apiKey: "test-key",
      models: [{
        id: "openai/gpt-4o",
        provider: "openrouter",
        displayName: "GPT-4o",
      }],
    });
    const model = await provider.buildModel("openai/gpt-4o");
    const filename = "✍️ Blogs Blog ideas.md";

    await model.invoke([new HumanMessage({
      content: [{
        type: "file",
        source_type: "base64",
        mime_type: "text/markdown",
        data: "IyBoaQ==",
        metadata: { name: filename },
      }] as unknown as string,
    })]);

    const init = fetchFn.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages).toEqual([{
      role: "user",
      content: [{
        type: "file",
        file: {
          file_data: "data:text/markdown;base64,IyBoaQ==",
          filename,
        },
      }],
    }]);
  });
});
