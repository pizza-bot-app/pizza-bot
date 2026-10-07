import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { OpperLangChainModelProvider } from "./opper.js";

beforeEach(() => {
  vi.stubEnv("OPPER_BASE_URL", "");
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

describe("Opper model discovery", () => {
  it("lists pools first, then the rest of the catalog", async () => {
    const fetchFn = catalogFetch({
      "https://opper.example/v3/compat/models?type=pool": {
        data: [{
          id: "claude-sonnet-4-6",
          context_length: 1_000_000,
          opper: {
            kind: "pool",
            type: "llm",
            capabilities: ["text", "tools", "vision"],
            max_output_tokens: 64_000,
          },
        }],
      },
      "https://opper.example/v3/compat/models": {
        data: [
          {
            id: "openai/gpt-4o-mini",
            context_length: 128_000,
            opper: {
              kind: "model",
              type: "llm",
              capabilities: ["text", "tools"],
              max_output_tokens: 16_384,
            },
          },
          { id: "claude-sonnet-4-6", opper: { kind: "pool", type: "llm" } },
          {
            id: "openai/text-embedding-3-small",
            opper: { kind: "model", type: "embedding", capabilities: ["embedding"] },
          },
        ],
      },
    });
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://opper.example/v3/compat/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "claude-sonnet-4-6",
        provider: "opper",
        displayName: "claude-sonnet-4-6 (Opper pool)",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "openai/gpt-4o-mini",
        provider: "opper",
        displayName: "openai/gpt-4o-mini (Opper)",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://opper.example/v3/compat/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("falls back to the full catalog when the pool listing is unavailable", async () => {
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://opper.example/v3/compat",
      fetch: catalogFetch({
        "https://opper.example/v3/compat/models": {
          data: [{ id: "openai/gpt-4o-mini", opper: { kind: "model", type: "llm" } }],
        },
      }),
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "openai/gpt-4o-mini", provider: "opper" }),
    ]);
  });

  it("reports rejected credentials from the catalog", async () => {
    const provider = new OpperLangChainModelProvider({
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
    vi.stubEnv("OPPER_API_KEY", "");
    const fetchFn = vi.fn();
    const provider = new OpperLangChainModelProvider({ apiKey: "", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fills missing native metadata from the Opper models.dev catalog", async () => {
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      fetch: catalogFetch({
        "https://api.opper.ai/v3/compat/models?type=pool": {
          data: [{ id: "claude-sonnet-4-6", opper: { kind: "pool" } }],
        },
        "https://api.opper.ai/v3/compat/models": { data: [] },
      }),
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        opper: {
          models: {
            "claude-sonnet-4-6": {
              limit: { context: 1_000_000, output: 64_000 },
              tool_call: true,
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      }), { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "claude-sonnet-4-6",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
      }),
    ]);
  });
  it("replaces a cleared custom endpoint with the environment fallback", async () => {
    vi.stubEnv("OPPER_BASE_URL", "https://opper-proxy.example/v3/compat");
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://opper-custom.example/v3/compat",
      fetch: fetchFn,
    });

    provider.configure({ method: "api-key", values: { apiKey: "test-key", baseUrl: "" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://opper-proxy.example/v3/compat/models",
      expect.any(Object),
    );
  });

  it("uses the default endpoint when no override is configured", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new OpperLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    provider.configure({ method: "api-key", values: { apiKey: "test-key" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.opper.ai/v3/compat/models",
      expect.any(Object),
    );
  });

  it("drops cached descriptors when the configuration changes", async () => {
    const fetchFn = catalogFetch({
      "https://opper.example/v3/compat/models": {
        data: [{
          id: "openai/gpt-4o-mini",
          opper: { kind: "model", type: "llm", max_output_tokens: 4_096 },
        }],
      },
      "https://opper-proxy.example/v3/compat/models": { data: [] },
    });
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://opper.example/v3/compat",
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });
    await provider.listModels();
    expect((await provider.buildModel("openai/gpt-4o-mini"))).toMatchObject({ maxTokens: 4_096 });

    provider.configure({
      method: "api-key",
      values: { apiKey: "test-key", baseUrl: "https://opper-proxy.example/v3/compat" },
    });

    expect((await provider.buildModel("openai/gpt-4o-mini"))).toMatchObject({ maxTokens: 8_192 });
  });
});

describe("Opper model construction", () => {
  it("builds a Chat Completions model with the configured output cap", async () => {
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      maxTokens: 32_000,
      models: [{
        id: "claude-sonnet-4-6",
        provider: "opper",
        displayName: "claude-sonnet-4-6 (Opper pool)",
        contextWindow: 1_000_000,
        maxOutputTokens: 16_000,
      }],
    });

    const model = await provider.buildModel("claude-sonnet-4-6");

    expect(model).toMatchObject({
      model: "claude-sonnet-4-6",
      apiKey: "test-key",
      maxTokens: 16_000,
    });
    expect(model._llmType()).toBe("openai");
    expect(model.profile.maxInputTokens).toBe(1_000_000);
  });

  it("classifies a missing API key as expired authentication", async () => {
    vi.stubEnv("OPPER_API_KEY", "");
    const provider = new OpperLangChainModelProvider({ apiKey: "" });

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
    const provider = new OpperLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://api.opper.ai/v3/compat",
      fetch: fetchFn,
      models: [{
        id: "gpt-5.4-mini",
        provider: "opper",
        displayName: "gpt-5.4-mini (Opper pool)",
      }],
    });
    const model = await provider.buildModel("gpt-5.4-mini");

    const reply = await model.invoke([new HumanMessage("hi")]);

    expect(reply.content).toBe("ok");
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.opper.ai/v3/compat/chat/completions");
    const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
    expect(body).toMatchObject({ model: "gpt-5.4-mini", max_tokens: 8_192 });
  });
});
