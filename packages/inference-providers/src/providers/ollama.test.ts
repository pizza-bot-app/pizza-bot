import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaLangChainModelProvider } from "./ollama.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Ollama model discovery", () => {
  it("reports an unavailable daemon as a retryable network failure", async () => {
    const cause = new TypeError("fetch failed");
    const provider = new OllamaLangChainModelProvider({
      fetch: vi.fn().mockRejectedValue(cause),
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "network",
      retryable: true,
      cause,
    });
  });

  it("reports daemon HTTP failures with endpoint retry semantics", async () => {
    const provider = new OllamaLangChainModelProvider({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "endpoint",
      retryable: true,
    });
  });

  it("reports the effective context limit used by the built model", async () => {
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "small:latest" }] });
      }
      return Response.json({
        capabilities: ["completion", "tools"],
        model_info: { "small.context_length": 8_192 },
      });
    });
    const provider = new OllamaLangChainModelProvider({
      contextLength: 32_768,
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([{
      id: "small:latest",
      provider: "ollama",
      displayName: "small:latest (Ollama)",
      contextWindow: 8_192,
      supportsTools: true,
    }]);

    const model = await provider.buildModel("small:latest");
    expect(model.profile.maxInputTokens).toBe(8_192);

    const overridden = await provider.buildModel("small:latest", {
      contextWindow: 16_384,
    }) as typeof model & { numCtx?: number };
    expect(overridden.numCtx).toBe(16_384);
    expect(overridden.profile.maxInputTokens).toBe(16_384);
  });

  it("replaces a cleared custom host with the environment fallback", async () => {
    vi.stubEnv("OLLAMA_HOST", "http://ollama-fallback.example");
    const fetchFn = vi.fn(async () => Response.json({ models: [] }));
    const provider = new OllamaLangChainModelProvider({
      host: "http://ollama-custom.example",
      fetch: fetchFn,
    });

    provider.configure({ method: "local", values: {} });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "http://ollama-fallback.example/api/tags",
      expect.any(Object),
    );
  });
});
