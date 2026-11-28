import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmtrLangChainModelProvider } from "./llmtr.js";

beforeEach(() => {
  vi.stubEnv("LLMTR_API_KEY", "");
  vi.stubEnv("LLMTR_BASE_URL", "");
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

describe("LLMTR model discovery", () => {
  it("lists models from an OpenAI-shaped catalog and reads OpenRouter-style fields when present", async () => {
    const fetchFn = catalogFetch({
      "https://llmtr.example/v1/models": {
        object: "list",
        data: [
          {
            id: "qwen/qwen3.8-flash",
            context_length: 131_072,
            max_output_tokens: 8_192,
            architecture: { input_modalities: ["text"] },
            supported_parameters: ["tools", "max_tokens"],
          },
          {
            id: "qwen/qwen3.8-max",
            context_length: 131_072,
            supports_tools: true,
          },
          { id: "mistral/devstral-medium-latest" },
          { id: "" },
        ],
      },
    });
    const provider = new LlmtrLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://llmtr.example/v1/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "qwen/qwen3.8-flash",
        provider: "llmtr",
        displayName: "qwen/qwen3.8-flash (LLMTR)",
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsVision: false,
      },
      {
        id: "qwen/qwen3.8-max",
        provider: "llmtr",
        displayName: "qwen/qwen3.8-max (LLMTR)",
        contextWindow: 131_072,
        supportsTools: true,
      },
      {
        id: "mistral/devstral-medium-latest",
        provider: "llmtr",
        displayName: "mistral/devstral-medium-latest (LLMTR)",
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://llmtr.example/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("uses the default endpoint when no override is configured", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new LlmtrLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    provider.configure({ method: "api-key", values: { apiKey: "test-key" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://llmtr.com/v1/models",
      expect.any(Object),
    );
  });
});
