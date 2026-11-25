import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
