import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { RequestyLangChainModelProvider } from "./requesty.js";

beforeEach(() => {
  vi.stubEnv("REQUESTY_BASE_URL", "");
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

describe("Requesty model discovery", () => {
  it("lists managed policies first, then the rest of the catalog", async () => {
    const fetchFn = catalogFetch({
      "https://requesty.example/v1/models/managed": {
        data: [{
          id: "claude-sonnet-4-5",
          api: "chat",
          context_window: 200_000,
          max_output_tokens: 64_000,
          supports_tool_calling: true,
          supports_vision: true,
        }],
      },
      "https://requesty.example/v1/models": {
        data: [
          {
            id: "openai/gpt-4o-mini",
            api: "chat",
            context_window: 128_000,
            max_output_tokens: 16_384,
            supports_tool_calling: true,
            supports_vision: false,
          },
          { id: "claude-sonnet-4-5", api: "chat" },
          { id: "openai/text-embedding-3-small", api: "embedding" },
        ],
      },
    });
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://requesty.example/v1/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "claude-sonnet-4-5",
        provider: "requesty",
        displayName: "claude-sonnet-4-5 (Requesty managed)",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "openai/gpt-4o-mini",
        provider: "requesty",
        displayName: "openai/gpt-4o-mini (Requesty)",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://requesty.example/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("falls back to the full catalog when managed policies are unavailable", async () => {
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://requesty.example/v1",
      fetch: catalogFetch({
        "https://requesty.example/v1/models": {
          data: [{ id: "openai/gpt-4o-mini", api: "chat" }],
        },
      }),
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "openai/gpt-4o-mini", provider: "requesty" }),
    ]);
  });

  it("reports rejected credentials from the catalog", async () => {
    const provider = new RequestyLangChainModelProvider({
      apiKey: "bad-key",
      fetch: vi.fn(async () => new Response("forbidden", { status: 403 })),
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "authentication",
      retryable: false,
    });
  });

  it("reports missing credentials without calling discovery", async () => {
    vi.stubEnv("REQUESTY_API_KEY", "");
    const fetchFn = vi.fn();
    const provider = new RequestyLangChainModelProvider({ apiKey: "", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fills missing native metadata from the Requesty models.dev catalog", async () => {
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      fetch: catalogFetch({
        "https://router.requesty.ai/v1/models/managed": {
          data: [{ id: "claude-sonnet-5", api: "chat" }],
        },
        "https://router.requesty.ai/v1/models": { data: [] },
      }),
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        requesty: {
          models: {
            "claude-sonnet-5": {
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
        id: "claude-sonnet-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsTools: true,
        supportsVision: true,
      }),
    ]);
  });
  it("replaces a cleared custom endpoint with the environment fallback", async () => {
    vi.stubEnv("REQUESTY_BASE_URL", "https://router.eu.requesty.ai/v1");
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://requesty-custom.example/v1",
      fetch: fetchFn,
    });

    provider.configure({ method: "api-key", values: { apiKey: "test-key", baseUrl: "" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://router.eu.requesty.ai/v1/models",
      expect.any(Object),
    );
  });

  it("uses the default endpoint when no override is configured", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new RequestyLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    provider.configure({ method: "api-key", values: { apiKey: "test-key" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://router.requesty.ai/v1/models",
      expect.any(Object),
    );
  });

  it("drops cached descriptors when the configuration changes", async () => {
    const fetchFn = catalogFetch({
      "https://requesty.example/v1/models": {
        data: [{ id: "openai/gpt-4o-mini", api: "chat", max_output_tokens: 4_096 }],
      },
      "https://router.eu.requesty.ai/v1/models": { data: [] },
    });
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://requesty.example/v1",
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });
    await provider.listModels();
    expect((await provider.buildModel("openai/gpt-4o-mini"))).toMatchObject({ maxTokens: 4_096 });

    provider.configure({
      method: "api-key",
      values: { apiKey: "test-key", baseUrl: "https://router.eu.requesty.ai/v1" },
    });

    expect((await provider.buildModel("openai/gpt-4o-mini"))).toMatchObject({ maxTokens: 8_192 });
  });
});

describe("Requesty model construction", () => {
  it("builds a Chat Completions model with the configured output cap", async () => {
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      maxTokens: 32_000,
      models: [{
        id: "anthropic/claude-sonnet-4-5",
        provider: "requesty",
        displayName: "anthropic/claude-sonnet-4-5 (Requesty)",
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      }],
    });

    const model = await provider.buildModel("anthropic/claude-sonnet-4-5");

    expect(model).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      apiKey: "test-key",
      maxTokens: 16_000,
    });
    expect(model._llmType()).toBe("openai");
    expect(model.profile.maxInputTokens).toBe(200_000);
  });

  it("classifies a missing API key as expired authentication", async () => {
    vi.stubEnv("REQUESTY_API_KEY", "");
    const provider = new RequestyLangChainModelProvider({ apiKey: "" });

    await expect(provider.buildModel("openai/gpt-4o-mini")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("sends chat completions to the configured base URL", async () => {
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({
      id: "chatcmpl-1",
      model: "gpt-4o-mini-2024-07-18",
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
    const provider = new RequestyLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://router.eu.requesty.ai/v1",
      fetch: fetchFn,
      models: [{
        id: "openai/gpt-4o-mini",
        provider: "requesty",
        displayName: "openai/gpt-4o-mini (Requesty)",
      }],
    });
    const model = await provider.buildModel("openai/gpt-4o-mini");

    const reply = await model.invoke([new HumanMessage("hi")]);

    expect(reply.content).toBe("ok");
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://router.eu.requesty.ai/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
    expect(body).toMatchObject({ model: "openai/gpt-4o-mini", max_tokens: 8_192 });
  });
});
