import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheaperInferenceLangChainModelProvider } from "./cheaperinference.js";

beforeEach(() => {
  vi.stubEnv("CHEAPER_INFERENCE_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Cheaper Inference model discovery", () => {
  it("lists the text chat models the key can use and drops non-text rows", async () => {
    const fetchFn = vi.fn(async () => Response.json({
      data: [
        {
          id: "gpt-5.4-mini",
          type: "text",
          context_length: 400_000,
          max_output_tokens: 128_000,
          capabilities: { vision: true },
        },
        { id: "text-embedding-3-small", type: "embedding" },
        { id: "untyped-chat" },
      ],
    }));
    const provider = new CheaperInferenceLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "gpt-5.4-mini",
        provider: "cheaperinference",
        displayName: "gpt-5.4-mini (Cheaper Inference)",
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsVision: true,
      },
      {
        id: "untyped-chat",
        provider: "cheaperinference",
        displayName: "untyped-chat (Cheaper Inference)",
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.cheaperinference.com/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });
});
