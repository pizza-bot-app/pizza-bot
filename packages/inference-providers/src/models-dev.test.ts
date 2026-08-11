import { describe, expect, it, vi } from "vitest";
import {
  enrichModelDescriptors,
  ModelsDevCatalogLoader,
} from "./models-dev.js";

describe("ModelsDevCatalogLoader", () => {
  it("coalesces provider lookups into one cached catalog request", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      anthropic: {
        models: {
          "claude-sonnet-5": { limit: { context: 1_000_000 } },
        },
      },
      "amazon-bedrock": {
        models: {
          "global.anthropic.claude-sonnet-5": {
            limit: { context: 1_000_000 },
          },
        },
      },
    }), { status: 200 }));
    const loader = new ModelsDevCatalogLoader({ fetch: fetchFn });

    const [anthropic, bedrock] = await Promise.all([
      loader.models("anthropic"),
      loader.models("amazon-bedrock"),
    ]);
    await loader.models("anthropic");

    expect(anthropic?.["claude-sonnet-5"]?.limit?.context).toBe(1_000_000);
    expect(bedrock?.["global.anthropic.claude-sonnet-5"]?.limit?.context)
      .toBe(1_000_000);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("fills missing metadata without replacing provider-native values", async () => {
    const loader = new ModelsDevCatalogLoader({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        openrouter: {
          models: {
            "anthropic/claude-sonnet-5": {
              limit: { context: 1_000_000, output: 128_000 },
              tool_call: true,
              modalities: { input: ["text", "image"] },
            },
          },
        },
      }), { status: 200 })),
    });

    await expect(enrichModelDescriptors([{
      id: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      displayName: "Claude Sonnet 5",
      contextWindow: 200_000,
    }], "openrouter", loader)).resolves.toEqual([{
      id: "anthropic/claude-sonnet-5",
      provider: "openrouter",
      displayName: "Claude Sonnet 5",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
    }]);
  });

  it("leaves descriptors unchanged when the catalog is unavailable", async () => {
    const loader = new ModelsDevCatalogLoader({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    });
    const descriptors = [{
      id: "model",
      provider: "provider",
      displayName: "Model",
    }];

    await expect(enrichModelDescriptors(descriptors, "provider", loader))
      .resolves.toBe(descriptors);
  });
});
