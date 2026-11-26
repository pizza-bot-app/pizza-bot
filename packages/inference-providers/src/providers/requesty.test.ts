import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
