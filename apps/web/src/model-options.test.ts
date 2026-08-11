import { describe, expect, it } from "vitest";
import type { ModelsInfo, ProviderView } from "@/api-client";
import {
  availableModels,
  configuredModels,
  groupModelsByProvider,
  providerLabel,
  reconcileSelectedModel,
} from "./model-options.js";

const models: ModelsInfo = {
  default: "anthropic:sonnet",
  models: [
    { id: "bedrock:sonnet", displayName: "Sonnet (Bedrock)", provider: "bedrock" },
    { id: "anthropic:sonnet", displayName: "Sonnet (Anthropic)", provider: "anthropic" },
    { id: "openai:gpt", displayName: "GPT (OpenAI)", provider: "openai" },
  ],
};

const provider = (
  id: string,
  options: {
    configurable?: boolean;
    configured?: boolean;
    availableWithoutConfig?: boolean;
  } = {},
): ProviderView => ({
  id,
  configurable: options.configurable ?? true,
  availableWithoutConfig:
    options.availableWithoutConfig ?? options.configurable === false,
  ...(options.configured
    ? { config: { method: "credentials", values: {} } }
    : {}),
  modelPreferences: { mode: "all", selected: [] },
});

describe("configuredModels", () => {
  it("includes only configurable providers saved in Settings", () => {
    const result = configuredModels(models, [
      provider("bedrock"),
      provider("anthropic", { configured: true }),
      provider("openai"),
    ]);

    expect(result.models.map((model) => model.id)).toEqual(["anthropic:sonnet"]);
    expect(result.default).toBe("anthropic:sonnet");
  });

  it("includes providers that require no Settings configuration", () => {
    const result = configuredModels(models, [
      provider("bedrock", { availableWithoutConfig: true }),
      provider("anthropic"),
      provider("openai"),
    ]);

    expect(result.models.map((model) => model.id)).toEqual(["bedrock:sonnet"]);
  });

  it("replaces an unavailable catalog default with the first configured model", () => {
    const result = configuredModels(models, [
      provider("bedrock", { availableWithoutConfig: true }),
      provider("anthropic"),
      provider("openai", { configured: true }),
    ]);

    expect(result.default).toBe("bedrock:sonnet");
  });

  it("filters a configured provider to its selected models", () => {
    const anthropic = provider("anthropic", { configured: true });
    anthropic.modelPreferences = { mode: "selected", selected: ["sonnet"] };
    const result = configuredModels(models, [provider("bedrock"), anthropic, provider("openai")]);

    expect(result.models.map((model) => model.id)).toEqual(["anthropic:sonnet"]);
  });
});

describe("availableModels", () => {
  it("preserves configured models until provider status is known", () => {
    expect(availableModels(models, undefined)).toBe(models);
  });

  it("removes models from unavailable providers and replaces their default", () => {
    const result = availableModels(models, [
      { name: "bedrock", status: "connected", modelCount: 1 },
      { name: "anthropic", status: "unavailable", modelCount: 0 },
      { name: "openai", status: "connected", modelCount: 1 },
    ]);

    expect(result.models.map((model) => model.id)).toEqual(["bedrock:sonnet", "openai:gpt"]);
    expect(result.default).toBe("bedrock:sonnet");
  });

  it("returns no selectable models when every provider is unavailable", () => {
    const result = availableModels(models, [
      { name: "bedrock", status: "unavailable", modelCount: 0 },
      { name: "anthropic", status: "unavailable", modelCount: 0 },
      { name: "openai", status: "unavailable", modelCount: 0 },
    ]);

    expect(result).toEqual({ models: [], default: "" });
  });
});

describe("model provider presentation", () => {
  it("groups models by provider while preserving catalog order", () => {
    const result = groupModelsByProvider(models.models);

    expect(result.map((group) => group.provider)).toEqual(["bedrock", "anthropic", "openai"]);
    expect(result[0]?.models.map(({ model, index }) => [model.id, index]))
      .toEqual([["bedrock:sonnet", 0]]);
  });

  it("formats provider identifiers for headings", () => {
    expect(providerLabel("openai")).toBe("Open AI");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
    expect(providerLabel("bedrock")).toBe("Amazon Bedrock");
    expect(providerLabel("google-vertex_ai")).toBe("Google Vertex Ai");
  });
});

describe("reconcileSelectedModel", () => {
  it("keeps a selected configured model", () => {
    expect(reconcileSelectedModel("openai:gpt", models)).toBe("openai:gpt");
  });

  it("falls back when a selected provider is removed", () => {
    const available = configuredModels(models, [
      provider("bedrock", { availableWithoutConfig: true }),
      provider("anthropic"),
      provider("openai"),
    ]);

    expect(reconcileSelectedModel("anthropic:sonnet", available)).toBe("bedrock:sonnet");
  });

  it("clears the selection when no providers are available", () => {
    expect(reconcileSelectedModel("anthropic:sonnet", { models: [], default: "" })).toBe("");
  });
});
