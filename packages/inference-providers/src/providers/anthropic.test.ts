import { describe, expect, it, vi } from "vitest";
import { AnthropicLangChainModelProvider } from "./anthropic.js";

describe("Anthropic model discovery", () => {
  it("lists models returned by Anthropic", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      ],
    }), { status: 200 }));
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://anthropic.example/",
      fetch: fetchFn,
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        anthropic: {
          models: {
            "claude-sonnet-5": {
              limit: { context: 1_000_000, output: 128_000 },
            },
          },
        },
      }), { status: 200 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5 (Anthropic)",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      }),
      expect.objectContaining({
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5 (Anthropic)",
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://anthropic.example/v1/models?limit=1000",
      expect.objectContaining({
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-key",
        },
      }),
    );
  });

  it("reports authentication failures", async () => {
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "authentication",
      retryable: false,
    });
  });
});

describe("Anthropic model construction", () => {
  it("discovers and projects catalog context while retaining native capabilities", async () => {
    const provider = new AnthropicLangChainModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
      }), { status: 200 })),
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        anthropic: {
          models: {
            "claude-sonnet-5": {
              limit: { context: 750_000 },
            },
          },
        },
      }), { status: 200 })),
    });

    const model = await provider.buildModel("claude-sonnet-5");

    expect(model.profile).toMatchObject({
      maxInputTokens: 750_000,
      imageInputs: true,
      toolCalling: true,
    });
  });
});
