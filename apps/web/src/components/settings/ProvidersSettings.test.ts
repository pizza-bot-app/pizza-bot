import { describe, expect, it } from "vitest";
import type { ProviderConfigView, ProviderView } from "@/api-client";
import type { ProviderAuthMethod } from "@pizza-bot/core";
import {
  getProviderStatus,
  secretKeysWithStoredValue,
  unavailableLocalSecretValidationError,
} from "./ProvidersSettings.js";

function provider(overrides: Partial<ProviderView>): ProviderView {
  return {
    id: "example",
    configurable: true,
    availableWithoutConfig: false,
    modelPreferences: { mode: "all", selected: [] },
    ...overrides,
  };
}

describe("getProviderStatus", () => {
  it("prioritizes an explicit saved configuration", () => {
    expect(
      getProviderStatus(
        provider({
          availableWithoutConfig: true,
          config: { method: "api-key", values: {} },
        }),
      ),
    ).toEqual({ label: "Configured", tone: "configured" });
  });

  it("identifies providers available through ambient configuration", () => {
    expect(getProviderStatus(provider({ availableWithoutConfig: true }))).toEqual({
      label: "Available",
      tone: "available",
    });
  });

  it("identifies providers that still need configuration", () => {
    expect(getProviderStatus(provider({}))).toEqual({
      label: "Not configured",
      tone: "unconfigured",
    });
  });

  it("prioritizes an unavailable saved secret", () => {
    expect(
      getProviderStatus(
        provider({
          authSchema: [{
            id: "api-key",
            label: "API key",
            fields: [{
              key: "apiKey",
              label: "API key",
              type: "password",
              required: true,
            }],
          }],
          config: {
            method: "api-key",
            values: { apiKey: { hasValue: true, available: false } },
          },
        }),
      ),
    ).toEqual({ label: "Needs attention", tone: "error" });
  });

  it("reports catalog failures for configured providers", () => {
    expect(
      getProviderStatus(
        provider({ config: { method: "api-key", values: {} } }),
        {
          provider: "example",
          status: "error",
          modelCount: 0,
          stale: false,
          code: "network",
          message: "Catalog endpoint is unreachable.",
          retryable: true,
        },
      ),
    ).toEqual({ label: "Unavailable", tone: "error" });
  });

  it("reports catalog failures neutrally for unconfigured ambient providers", () => {
    expect(
      getProviderStatus(
        provider({ id: "ollama", availableWithoutConfig: true }),
        {
          provider: "ollama",
          status: "error",
          modelCount: 0,
          stale: false,
          code: "network",
          message: "Ollama is not reachable.",
          retryable: true,
        },
      ),
    ).toEqual({ label: "Unavailable", tone: "unavailable" });
  });

  it("keeps a partially listed provider usable while surfacing the gap separately", () => {
    expect(
      getProviderStatus(
        provider({ id: "bedrock", config: { method: "aws-profile", values: {} } }),
        {
          provider: "bedrock",
          status: "degraded",
          modelCount: 55,
          stale: true,
          code: "unavailable",
          message: "Amazon Bedrock inference profiles could not be listed.",
          retryable: true,
        },
      ),
    ).toEqual({ label: "Configured", tone: "configured" });
  });

  it("uses live health before catalog status is available", () => {
    expect(
      getProviderStatus(
        provider({ id: "ollama", availableWithoutConfig: true }),
        undefined,
        { name: "ollama", status: "unavailable", modelCount: 0 },
      ),
    ).toEqual({ label: "Unavailable", tone: "unavailable" });
  });
});

describe("secretKeysWithStoredValue", () => {
  const method: ProviderAuthMethod = {
    id: "api-key",
    label: "API key",
    fields: [{
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
    }],
  };
  const config: ProviderConfigView = {
    method: "api-key",
    values: { apiKey: { hasValue: true, available: false } },
  };

  it("requires local desktop re-entry for an unavailable encrypted secret", () => {
    expect(secretKeysWithStoredValue(method, config, false)).toEqual([]);
  });

  it("preserves an unresolved server environment reference", () => {
    expect(secretKeysWithStoredValue(method, config, true)).toEqual(["apiKey"]);
  });
});

describe("unavailableLocalSecretValidationError", () => {
  const method: ProviderAuthMethod = {
    id: "api-key",
    label: "API key",
    fields: [{
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
    }],
  };
  const unavailable = new Set(["apiKey"]);

  it("requires an unreadable desktop credential before saving", () => {
    expect(
      unavailableLocalSecretValidationError(method, {}, unavailable, true),
    ).toBe("Re-enter API key before saving.");
  });

  it("accepts a re-entered desktop credential", () => {
    expect(
      unavailableLocalSecretValidationError(
        method,
        { apiKey: "replacement" },
        unavailable,
        true,
      ),
    ).toBeUndefined();
  });

  it("leaves unresolved server references to server-environment guidance", () => {
    expect(
      unavailableLocalSecretValidationError(method, {}, unavailable, false),
    ).toBeUndefined();
  });
});
