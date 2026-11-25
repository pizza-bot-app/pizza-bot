import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
