import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry, type ProviderConfigPort } from "@pizza-bot/core";
import { registerBuiltinProviders } from "./loader.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerBuiltinProviders", () => {
  it("registers each provider once, under a display label", async () => {
    const registry = new ModelRegistry();

    await registerBuiltinProviders(registry);

    const providers = registry.listProviders();
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
    for (const provider of providers) expect(provider.label.trim()).not.toBe("");
  });

  it("registers a provider whose saved settings no longer validate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configs = {
      getConfig: (id: string) =>
        id === "requesty"
          ? { method: "api-key", values: { apiKey: "k", requestOverrides: "{not json" } }
          : undefined,
      getModelPreferences: () => undefined,
    } as unknown as ProviderConfigPort;
    const registry = new ModelRegistry();

    await registerBuiltinProviders(registry, configs);

    expect(registry.listProviders().map((p) => p.id)).toContain("requesty");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ignoring saved requesty settings: Advanced request JSON is not valid JSON"),
    );
  });
});
