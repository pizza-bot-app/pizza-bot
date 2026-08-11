import { describe, expect, it, vi } from "vitest";
import { isChatModel, OpenAiLangChainModelProvider, retryOutputCap } from "./openai.js";

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

  it("projects catalog context into the model profile", async () => {
    const provider = new OpenAiLangChainModelProvider({
      apiKey: "test-key",
      models: [{
        id: "custom-chat-model",
        provider: "openai",
        displayName: "Custom Chat Model",
        contextWindow: 40_960,
      }],
    });

    const model = await provider.buildModel("custom-chat-model");

    expect(model.profile.maxInputTokens).toBe(40_960);
  });
});
