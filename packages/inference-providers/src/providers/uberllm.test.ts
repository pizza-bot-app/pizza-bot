import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { UberLlmLangChainModelProvider } from "./uberllm.js";

beforeEach(() => {
  vi.stubEnv("UBERLLM_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function catalogFetch(catalogs: Record<string, unknown>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const body = catalogs[String(input)];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("UberLLM model discovery", () => {
  it("lists available chat models with the metadata from the listing", async () => {
    const fetchFn = catalogFetch({
      "https://uberllm.example/v1/models": {
        object: "list",
        data: [
          {
            id: "anthropic/claude-sonnet-4.6",
            type: "chat",
            available: true,
            context_length: 1_000_000,
            max_output_tokens: 64_000,
            supports_tools: true,
            supports_vision: true,
          },
          {
            id: "deepseek/deepseek-v4.1-flash",
            type: "chat",
            available: true,
            context_length: 1_048_576,
            max_output_tokens: 384_000,
            supports_tools: true,
            supports_vision: true,
          },
          { id: "anthropic/claude-sonnet-4.6", type: "chat", available: true },
          { id: "vendor/offline-model", type: "chat", available: false },
          { id: "black-forest-labs/flux-schnell", type: "image", available: true },
        ],
      },
    });
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://uberllm.example/v1/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "anthropic/claude-sonnet-4.6",
        provider: "uberllm",
        displayName: "anthropic/claude-sonnet-4.6 (UberLLM)",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "deepseek/deepseek-v4.1-flash",
        provider: "uberllm",
        displayName: "deepseek/deepseek-v4.1-flash (UberLLM)",
        contextWindow: 1_048_576,
        maxOutputTokens: 384_000,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://uberllm.example/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("leaves metadata unset when the listing omits it", async () => {
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "test-key",
      fetch: catalogFetch({
        "https://api.uberllm.dev/v1/models": { data: [{ id: "typesafe/jev-1.14" }] },
      }),
    });

    await expect(provider.listModels()).resolves.toEqual([
      { id: "typesafe/jev-1.14", provider: "uberllm", displayName: "typesafe/jev-1.14 (UberLLM)" },
    ]);
  });

  it("reports rejected credentials from the catalog", async () => {
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "bad-key",
      fetch: vi.fn(async () => new Response("unauthorized", { status: 401 })),
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "authentication",
      retryable: false,
    });
  });

  it("reports missing credentials without calling discovery", async () => {
    vi.stubEnv("UBERLLM_API_KEY", "");
    const fetchFn = vi.fn();
    const provider = new UberLlmLangChainModelProvider({ apiKey: "", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads the key from UBERLLM_API_KEY", async () => {
    vi.stubEnv("UBERLLM_API_KEY", "env-key");
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new UberLlmLangChainModelProvider({ fetch: fetchFn });

    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.uberllm.dev/v1/models",
      expect.objectContaining({ headers: { authorization: "Bearer env-key" } }),
    );
  });

  it("replaces a cleared custom endpoint with the environment fallback", async () => {
    vi.stubEnv("UBERLLM_BASE_URL", "https://uberllm-proxy.example/v1");
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://uberllm-custom.example/v1",
      fetch: fetchFn,
    });

    provider.configure({ method: "api-key", values: { apiKey: "test-key", baseUrl: "" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://uberllm-proxy.example/v1/models",
      expect.any(Object),
    );
  });

  it("uses the default endpoint when no override is configured", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new UberLlmLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    provider.configure({ method: "api-key", values: { apiKey: "test-key" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.uberllm.dev/v1/models",
      expect.any(Object),
    );
  });

  it("drops cached descriptors when the configuration changes", async () => {
    const fetchFn = catalogFetch({
      "https://uberllm.example/v1/models": {
        data: [{ id: "deepseek/deepseek-v4.1-flash", type: "chat", max_output_tokens: 4_096 }],
      },
      "https://uberllm-proxy.example/v1/models": { data: [] },
    });
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://uberllm.example/v1",
      fetch: fetchFn,
    });
    await provider.listModels();
    expect((await provider.buildModel("deepseek/deepseek-v4.1-flash"))).toMatchObject({ maxTokens: 4_096 });

    provider.configure({
      method: "api-key",
      values: { apiKey: "test-key", baseUrl: "https://uberllm-proxy.example/v1" },
    });

    expect((await provider.buildModel("deepseek/deepseek-v4.1-flash"))).toMatchObject({ maxTokens: 8_192 });
  });
});

describe("UberLLM model construction", () => {
  it("builds a Chat Completions model with the configured output cap", async () => {
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "test-key",
      maxTokens: 32_000,
      models: [{
        id: "anthropic/claude-sonnet-4.6",
        provider: "uberllm",
        displayName: "anthropic/claude-sonnet-4.6 (UberLLM)",
        contextWindow: 1_000_000,
        maxOutputTokens: 16_000,
      }],
    });

    const model = await provider.buildModel("anthropic/claude-sonnet-4.6");

    expect(model).toMatchObject({
      model: "anthropic/claude-sonnet-4.6",
      apiKey: "test-key",
      maxTokens: 16_000,
    });
    expect(model._llmType()).toBe("openai");
    expect(model.profile.maxInputTokens).toBe(1_000_000);
  });

  it("classifies a missing API key as expired authentication", async () => {
    vi.stubEnv("UBERLLM_API_KEY", "");
    const provider = new UberLlmLangChainModelProvider({ apiKey: "" });

    await expect(provider.buildModel("deepseek/deepseek-v4.1-flash")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("sends chat completions to the configured base URL", async () => {
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({
      id: "chatcmpl-1",
      model: "deepseek/deepseek-v4.1-flash",
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
    const provider = new UberLlmLangChainModelProvider({
      apiKey: "test-key",
      fetch: fetchFn,
      models: [{
        id: "deepseek/deepseek-v4.1-flash",
        provider: "uberllm",
        displayName: "deepseek/deepseek-v4.1-flash (UberLLM)",
      }],
    });
    const model = await provider.buildModel("deepseek/deepseek-v4.1-flash");

    const reply = await model.invoke([new HumanMessage("hi")]);

    expect(reply.content).toBe("ok");
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.uberllm.dev/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
    expect(body).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", max_tokens: 8_192 });
  });
});
