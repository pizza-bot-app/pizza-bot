import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { CheaperInferenceLangChainModelProvider } from "./cheaperinference.js";

beforeEach(() => {
  vi.stubEnv("CHEAPER_INFERENCE_BASE_URL", "");
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

describe("Cheaper Inference model discovery", () => {
  it("lists the text chat models the key can use and drops non-text rows", async () => {
    const fetchFn = catalogFetch({
      "https://ci.example/v1/models": {
        data: [
          {
            id: "gpt-5.4-mini",
            type: "text",
            context_length: 400_000,
            max_output_tokens: 128_000,
            capabilities: { vision: true },
          },
          { id: "text-embedding-3-small", type: "embedding" },
        ],
      },
    });
    const provider = new CheaperInferenceLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://ci.example/v1/",
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "gpt-5.4-mini",
        provider: "cheaperinference",
        displayName: "gpt-5.4-mini (Cheaper Inference)",
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsVision: true,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://ci.example/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("reports rejected credentials from the catalog", async () => {
    const provider = new CheaperInferenceLangChainModelProvider({
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
    vi.stubEnv("CHEAPER_INFERENCE_API_KEY", "");
    const fetchFn = vi.fn();
    const provider = new CheaperInferenceLangChainModelProvider({ apiKey: "", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fills missing native metadata from the Cheaper Inference models.dev catalog", async () => {
    const provider = new CheaperInferenceLangChainModelProvider({
      apiKey: "test-key",
      fetch: catalogFetch({
        "https://api.cheaperinference.com/v1/models": {
          data: [{ id: "claude-sonnet-5", type: "text" }],
        },
      }),
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        cheaperinference: {
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
    vi.stubEnv("CHEAPER_INFERENCE_BASE_URL", "https://ci.internal.example/v1");
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new CheaperInferenceLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://ci-custom.example/v1",
      fetch: fetchFn,
    });

    provider.configure({ method: "api-key", values: { apiKey: "test-key", baseUrl: "" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://ci.internal.example/v1/models",
      expect.any(Object),
    );
  });

  it("uses the default endpoint when no override is configured", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new CheaperInferenceLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    provider.configure({ method: "api-key", values: { apiKey: "test-key" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.cheaperinference.com/v1/models",
      expect.any(Object),
    );
  });

  it("drops cached descriptors when the configuration changes", async () => {
    const fetchFn = catalogFetch({
      "https://ci.example/v1/models": {
        data: [{ id: "gpt-5.4-mini", type: "text", max_output_tokens: 4_096 }],
      },
      "https://api.cheaperinference.com/v1/models": { data: [] },
    });
    const provider = new CheaperInferenceLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://ci.example/v1",
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });
    await provider.listModels();
    expect((await provider.buildModel("gpt-5.4-mini"))).toMatchObject({ maxTokens: 4_096 });

    provider.configure({
      method: "api-key",
      values: { apiKey: "test-key", baseUrl: "https://api.cheaperinference.com/v1" },
    });

    expect((await provider.buildModel("gpt-5.4-mini"))).toMatchObject({ maxTokens: 8_192 });
  });
});

describe("Cheaper Inference model construction", () => {
  it("builds a Chat Completions model with the configured output cap", async () => {
    const provider = new CheaperInferenceLangChainModelProvider({
      apiKey: "test-key",
      maxTokens: 32_000,
      models: [{
        id: "claude-sonnet-5",
        provider: "cheaperinference",
        displayName: "claude-sonnet-5 (Cheaper Inference)",
        contextWindow: 1_000_000,
        maxOutputTokens: 16_000,
      }],
    });

    const model = await provider.buildModel("claude-sonnet-5");

    expect(model).toMatchObject({
      model: "claude-sonnet-5",
      apiKey: "test-key",
      maxTokens: 16_000,
    });
    expect(model._llmType()).toBe("openai");
    expect(model.profile.maxInputTokens).toBe(1_000_000);
  });

  it("classifies a missing API key as expired authentication", async () => {
    vi.stubEnv("CHEAPER_INFERENCE_API_KEY", "");
    const provider = new CheaperInferenceLangChainModelProvider({ apiKey: "" });

    await expect(provider.buildModel("gpt-5.4-mini")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("sends chat completions to the configured base URL", async () => {
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({
      id: "chatcmpl-1",
      model: "gpt-5.4-mini",
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
    const provider = new CheaperInferenceLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://api.cheaperinference.com/v1",
      fetch: fetchFn,
      models: [{
        id: "claude-sonnet-5",
        provider: "cheaperinference",
        displayName: "claude-sonnet-5 (Cheaper Inference)",
      }],
    });
    const model = await provider.buildModel("claude-sonnet-5");

    const reply = await model.invoke([new HumanMessage("hi")]);

    expect(reply.content).toBe("ok");
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.cheaperinference.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
    expect(body).toMatchObject({ model: "claude-sonnet-5", max_tokens: 8_192 });
  });
});
