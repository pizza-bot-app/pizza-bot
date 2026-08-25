import { describe, expect, it, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  ModelCatalogError,
  ModelRegistry,
  ModelUnavailableError,
  automaticModelCatalog,
  recommendedModelCandidates,
  type ModelDescriptor,
  type ModelProvider,
} from "./model-provider.js";

function stubProvider(opts: {
  id?: string;
  models?: ModelDescriptor[];
  build?: (modelId: string) => Promise<BaseChatModel>;
  onBuild?: (modelId: string) => void;
}): ModelProvider {
  const id = opts.id ?? "stub";
  const models = opts.models ?? [
    { id: "model-a", provider: id, displayName: "Model A" },
  ];
  return {
    id,
    async listModels() {
      return models;
    },
    async buildModel(modelId: string) {
      opts.onBuild?.(modelId);
      if (opts.build) return opts.build(modelId);
      return { modelId } as unknown as BaseChatModel;
    },
  };
}

describe("ModelRegistry.validate", () => {
  it("reports a known catalog model as available with its descriptor", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({}));
    const result = await registry.validate("stub:model-a");
    expect(result).toMatchObject({ available: true, provider: "stub", modelId: "model-a" });
  });

  it("treats a provider catalog as suggestions rather than an allowlist", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({}));
    const result = await registry.validate("stub:model-missing");
    expect(result).toEqual({
      available: true,
      provider: "stub",
      modelId: "model-missing",
    });
  });

  it("distinguishes an unregistered provider", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({}));
    const result = await registry.validate("nope:model-a");
    expect(result).toMatchObject({ available: false, reason: "unregistered-provider" });
  });

  it("distinguishes a malformed (colon-less) id", async () => {
    const registry = new ModelRegistry();
    const result = await registry.validate("no-colon-here");
    expect(result).toMatchObject({ available: false, reason: "malformed-id" });
  });

  it("does not let failed catalog discovery block a provider-owned model id", async () => {
    const registry = new ModelRegistry();
    const provider = stubProvider({});
    provider.listModels = async () => {
      throw new Error("catalog offline");
    };
    registry.register(provider);

    await expect(registry.resolveModel("stub:private-deployment")).resolves.toBeDefined();
  });
});

describe("ModelRegistry.resolveModel (requested selection)", () => {
  it("builds a known model", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({}));
    await expect(registry.resolveModel("stub:model-a")).resolves.toBeDefined();
  });

  it("asks a registered provider to build a model absent from its catalog", async () => {
    const built: string[] = [];
    const registry = new ModelRegistry();
    registry.register(stubProvider({ onBuild: (modelId) => built.push(modelId) }));
    await expect(registry.resolveModel("stub:unlisted")).resolves.toBeDefined();
    expect(built).toEqual(["unlisted"]);
  });

  it("throws ModelUnavailableError(unregistered-provider)", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({}));
    await expect(registry.resolveModel("ghost:model-a")).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("wraps a provider build failure and propagates a provider-tagged code", async () => {
    const registry = new ModelRegistry();
    registry.register(
      stubProvider({
        build: async () => {
          throw Object.assign(new Error("The security token included in the request is expired"), {
            code: "AUTH_EXPIRED",
          });
        },
      }),
    );
    const err = await registry.resolveModel("stub:model-a").catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err.reason).toBe("build-failed");
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.message).toContain("unavailable");
  });
});

describe("ModelRegistry.listAll", () => {
  it("caches discovery and invalidates it when a provider is configured", async () => {
    let calls = 0;
    const provider = stubProvider({});
    provider.listModels = async () => {
      calls += 1;
      return [{ id: "model-a", provider: "stub", displayName: "Model A" }];
    };
    provider.configure = () => {};
    const registry = new ModelRegistry();
    registry.register(provider);

    await registry.listAll();
    await registry.listAll();
    expect(calls).toBe(1);

    registry.configureProvider("stub", { method: "test", values: {} });
    await registry.listAll();
    expect(calls).toBe(2);
  });

  it("filters selected models while retaining an unfiltered catalog view", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({
      models: [
        { id: "model-a", provider: "stub", displayName: "Model A" },
        { id: "model-b", provider: "stub", displayName: "Model B" },
      ],
    }));

    registry.setEnabledModels("stub", ["model-b"]);
    await expect(registry.listAll()).resolves.toEqual([
      expect.objectContaining({ id: "model-b" }),
    ]);
    await expect(registry.listAll({ includeDisabled: true })).resolves.toHaveLength(2);

    registry.setEnabledModels("stub", undefined);
    await expect(registry.listAll()).resolves.toHaveLength(2);
  });

  it("reports provider failures without hiding successful catalogs", async () => {
    const registry = new ModelRegistry();
    registry.register(stubProvider({ id: "healthy" }));
    const failing = stubProvider({ id: "failing" });
    failing.listModels = async () => {
      throw new ModelCatalogError("network", "Catalog endpoint is unreachable.", true);
    };
    registry.register(failing);

    await expect(registry.listCatalog()).resolves.toEqual({
      models: [expect.objectContaining({ provider: "healthy" })],
      providers: [
        expect.objectContaining({ provider: "healthy", status: "ready" }),
        expect.objectContaining({
          provider: "failing",
          status: "error",
          code: "network",
          retryable: true,
          stale: false,
        }),
      ],
    });
  });

  it("does not expose unexpected provider error details in catalog status", async () => {
    const registry = new ModelRegistry();
    const failing = stubProvider({});
    failing.listModels = async () => {
      throw new Error("request failed with secret token abc123");
    };
    registry.register(failing);

    const snapshot = await registry.listCatalog();

    expect(snapshot.providers).toEqual([
      expect.objectContaining({
        status: "error",
        message: "Model catalog discovery failed.",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("abc123");
  });

  it("retains the last good catalog and refreshes on demand", async () => {
    let fail = false;
    const provider = stubProvider({});
    provider.listModels = vi.fn(async () => {
      if (fail) throw new ModelCatalogError("network", "Temporarily offline.", true);
      return [{ id: "model-a", provider: "stub", displayName: "Model A" }];
    });
    const registry = new ModelRegistry();
    registry.register(provider);

    await registry.listCatalog();
    fail = true;
    const stale = await registry.listCatalog({ refresh: true });

    expect(provider.listModels).toHaveBeenCalledTimes(2);
    expect(stale.models).toEqual([expect.objectContaining({ id: "model-a" })]);
    expect(stale.providers).toEqual([
      expect.objectContaining({ status: "error", stale: true, modelCount: 1 }),
    ]);
  });

  it("deduplicates concurrent discovery", async () => {
    let release!: (models: ModelDescriptor[]) => void;
    const pending = new Promise<ModelDescriptor[]>((resolve) => {
      release = resolve;
    });
    const provider = stubProvider({});
    provider.listModels = vi.fn(() => pending);
    const registry = new ModelRegistry();
    registry.register(provider);

    const first = registry.listCatalog();
    const second = registry.listCatalog();
    release([{ id: "model-a", provider: "stub", displayName: "Model A" }]);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(provider.listModels).toHaveBeenCalledOnce();
  });

  it("does not cache discovery started before a configuration change", async () => {
    let release!: (models: ModelDescriptor[]) => void;
    const pending = new Promise<ModelDescriptor[]>((resolve) => {
      release = resolve;
    });
    let configured = false;
    const provider = stubProvider({});
    provider.listModels = vi.fn(() =>
      configured
        ? Promise.resolve([{ id: "new", provider: "stub", displayName: "New" }])
        : pending
    );
    provider.configure = () => {
      configured = true;
    };
    const registry = new ModelRegistry();
    registry.register(provider);

    const oldRequest = registry.listCatalog();
    registry.configureProvider("stub", { method: "test", values: {} });
    const newRequest = registry.listCatalog();
    release([{ id: "old", provider: "stub", displayName: "Old" }]);

    await expect(oldRequest).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "old" })],
    });
    await expect(newRequest).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "new" })],
    });
    await expect(registry.listCatalog()).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "new" })],
    });
  });
});

describe("ModelRegistry degraded catalogs", () => {
  it("reports a provider that lost a catalog source without discarding its models", async () => {
    const provider = stubProvider({});
    provider.catalogDegradation = () => ({
      code: "unavailable",
      message: "Amazon Bedrock inference profiles could not be listed.",
      retryable: true,
      stale: false,
    });
    const registry = new ModelRegistry();
    registry.register(provider);

    const snapshot = await registry.listCatalog();

    expect(snapshot.models).toEqual([expect.objectContaining({ id: "model-a" })]);
    expect(snapshot.providers).toEqual([
      expect.objectContaining({
        status: "degraded",
        code: "unavailable",
        modelCount: 1,
        stale: false,
        retryable: true,
      }),
    ]);
  });

  it("asks about the exact listing it received rather than provider-wide state", async () => {
    const provider = stubProvider({});
    const listing = [{ id: "model-a", provider: "stub", displayName: "Model A" }];
    provider.listModels = async () => listing;
    const asked: unknown[] = [];
    provider.catalogDegradation = (models) => {
      asked.push(models);
      return undefined;
    };
    const registry = new ModelRegistry();
    registry.register(provider);

    await registry.listCatalog();

    expect(asked).toEqual([listing]);
    expect(asked[0]).toBe(listing);
  });

  it("never lets a partial catalog become the last-good fallback", async () => {
    let degraded = false;
    const provider = stubProvider({});
    provider.listModels = async () =>
      degraded
        ? [{ id: "model-a", provider: "stub", displayName: "Model A" }]
        : [
            { id: "model-a", provider: "stub", displayName: "Model A" },
            { id: "model-b", provider: "stub", displayName: "Model B" },
          ];
    provider.catalogDegradation = () =>
      degraded
        ? { code: "network", message: "One source timed out.", retryable: true, stale: false }
        : undefined;
    const registry = new ModelRegistry();
    registry.register(provider);

    await registry.listCatalog();
    degraded = true;
    await registry.listCatalog({ refresh: true });
    provider.listModels = async () => {
      throw new ModelCatalogError("network", "Temporarily offline.", true);
    };
    const stale = await registry.listCatalog({ refresh: true });

    expect(stale.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(stale.providers).toEqual([
      expect.objectContaining({ status: "error", stale: true, modelCount: 2 }),
    ]);
  });
});

describe("automaticModelCatalog", () => {
  function sonnetProvider(id: string): ModelProvider {
    return stubProvider({
      id,
      models: [{ id: "claude-sonnet-5", provider: id, displayName: "Claude Sonnet 5" }],
    });
  }

  it("reports a complete catalog when every listing provider is ready", async () => {
    const registry = new ModelRegistry();
    registry.register(sonnetProvider("stub"));

    await expect(automaticModelCatalog(registry)).resolves.toEqual({
      ids: ["stub:claude-sonnet-5"],
      complete: true,
    });
  });

  it("treats an unconfigured provider that lists nothing as no loss", async () => {
    const registry = new ModelRegistry();
    registry.register(sonnetProvider("stub"));
    const unconfigured = stubProvider({ id: "openai" });
    unconfigured.listModels = async () => {
      throw new ModelCatalogError("credentials", "OpenAI credentials are not available.", false);
    };
    registry.register(unconfigured);

    await expect(automaticModelCatalog(registry)).resolves.toEqual({
      ids: ["stub:claude-sonnet-5"],
      complete: true,
    });
  });

  it("keeps the remembered pick while a provider serves its last known models", async () => {
    let fail = false;
    const provider = stubProvider({
      id: "stub",
      models: [
        { id: "claude-sonnet-5", provider: "stub", displayName: "Claude Sonnet 5" },
        { id: "claude-opus-5", provider: "stub", displayName: "Claude Opus 5" },
      ],
    });
    const listModels = provider.listModels.bind(provider);
    provider.listModels = async () => {
      if (fail) throw new ModelCatalogError("authentication", "Credentials expired.", false);
      return listModels();
    };
    const registry = new ModelRegistry();
    registry.register(provider);

    await registry.listCatalog();
    fail = true;
    await registry.listCatalog({ refresh: true });

    await expect(automaticModelCatalog(registry, "stub:claude-opus-5")).resolves.toEqual({
      ids: ["stub:claude-opus-5", "stub:claude-sonnet-5"],
      complete: false,
      keeping: "stub:claude-opus-5",
    });
  });

  it("reports an empty catalog as incomplete", async () => {
    const provider = stubProvider({ id: "stub" });
    provider.listModels = async () => {
      throw new ModelCatalogError("authentication", "Credentials expired.", false);
    };
    const registry = new ModelRegistry();
    registry.register(provider);

    await expect(automaticModelCatalog(registry)).resolves.toEqual({
      ids: [],
      complete: false,
    });
  });

  it("reports an incomplete catalog while a provider is degraded", async () => {
    const provider = sonnetProvider("stub");
    provider.catalogDegradation = () => ({
      code: "authentication",
      message: "Credentials expired.",
      retryable: false,
      stale: true,
    });
    const registry = new ModelRegistry();
    registry.register(provider);

    await expect(automaticModelCatalog(registry)).resolves.toMatchObject({
      complete: false,
    });
  });

  it("does not repick when the remembered provider failed outright beside a healthy one", async () => {
    const registry = new ModelRegistry();
    registry.register(sonnetProvider("anthropic"));
    const bedrock = stubProvider({ id: "bedrock" });
    bedrock.listModels = async () => {
      throw new ModelCatalogError("authentication", "The security token is expired.", true);
    };
    registry.register(bedrock);

    await expect(
      automaticModelCatalog(registry, "bedrock:global.anthropic.claude-sonnet-5"),
    ).resolves.toEqual({
      ids: ["bedrock:global.anthropic.claude-sonnet-5", "anthropic:claude-sonnet-5"],
      complete: false,
      keeping: "bedrock:global.anthropic.claude-sonnet-5",
    });
  });

  it("lets an unconfigured remembered provider void its own pick", async () => {
    const registry = new ModelRegistry();
    registry.register(sonnetProvider("anthropic"));
    const bedrock = stubProvider({ id: "bedrock" });
    bedrock.listModels = async () => {
      throw new ModelCatalogError("credentials", "Bedrock credentials are not available.", false);
    };
    registry.register(bedrock);

    await expect(
      automaticModelCatalog(registry, "bedrock:global.anthropic.claude-sonnet-5"),
    ).resolves.toEqual({
      ids: ["anthropic:claude-sonnet-5"],
      complete: true,
    });
  });

  it("does not resurrect a remembered model the user has since disabled", async () => {
    const registry = new ModelRegistry();
    const provider = stubProvider({
      id: "stub",
      models: [
        { id: "claude-sonnet-5", provider: "stub", displayName: "Claude Sonnet 5" },
        { id: "claude-opus-5", provider: "stub", displayName: "Claude Opus 5" },
      ],
    });
    provider.catalogDegradation = () => ({
      code: "network",
      message: "One source timed out.",
      retryable: true,
      stale: false,
    });
    registry.register(provider);
    registry.setEnabledModels("stub", ["claude-sonnet-5"]);

    await expect(automaticModelCatalog(registry, "stub:claude-opus-5")).resolves.toEqual({
      ids: ["stub:claude-sonnet-5"],
      complete: false,
    });
  });
});

describe("recommendedModelCandidates", () => {
  it("prefers the newest Sonnet balanced model over catalog order and Opus", () => {
    const models: ModelDescriptor[] = [
      { id: "claude-opus-5", provider: "bedrock", displayName: "Claude Opus 5", supportsTools: true },
      { id: "claude-sonnet-4-6", provider: "bedrock", displayName: "Claude Sonnet 4.6", supportsTools: true },
      { id: "claude-sonnet-5", provider: "bedrock", displayName: "Claude Sonnet 5", supportsTools: true },
    ];

    expect(recommendedModelCandidates(models).map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-opus-5",
    ]);
  });

  it("prefers a global Bedrock profile over a US profile at the same score", () => {
    const models: ModelDescriptor[] = [
      {
        id: "us.anthropic.claude-sonnet-5",
        provider: "bedrock",
        displayName: "US Claude Sonnet 5",
        supportsTools: true,
      },
      {
        id: "global.anthropic.claude-sonnet-5",
        provider: "bedrock",
        displayName: "Global Claude Sonnet 5",
        supportsTools: true,
      },
    ];

    expect(recommendedModelCandidates(models).map((model) => model.id)).toEqual([
      "global.anthropic.claude-sonnet-5",
      "us.anthropic.claude-sonnet-5",
    ]);
  });

  it("excludes models explicitly known not to support tools", () => {
    const models: ModelDescriptor[] = [
      { id: "claude-sonnet-5", provider: "router", displayName: "Sonnet", supportsTools: false },
      { id: "local-agent", provider: "ollama", displayName: "Local Agent", supportsTools: true },
    ];

    expect(recommendedModelCandidates(models).map((model) => model.id)).toEqual(["local-agent"]);
  });

  it("uses qualified IDs as the stable fallback order for unranked models", () => {
    const models: ModelDescriptor[] = [
      { id: "zeta", provider: "openai", displayName: "Zeta" },
      { id: "alpha", provider: "google", displayName: "Alpha" },
    ];

    expect(recommendedModelCandidates(models).map((model) => `${model.provider}:${model.id}`))
      .toEqual(["google:alpha", "openai:zeta"]);
  });

  it("does not treat a release date as a model version", () => {
    const models: ModelDescriptor[] = [
      {
        id: "claude-sonnet-4-20250514",
        provider: "anthropic",
        displayName: "Claude Sonnet 4",
        supportsTools: true,
      },
      {
        id: "claude-sonnet-5",
        provider: "anthropic",
        displayName: "Claude Sonnet 5",
        supportsTools: true,
      },
    ];

    expect(recommendedModelCandidates(models)[0]?.id).toBe("claude-sonnet-5");
  });

  it("does not rank a legacy date-stamped Haiku above Sonnet", () => {
    const models: ModelDescriptor[] = [
      {
        id: "anthropic.claude-3-haiku-20240307-v1:0",
        provider: "bedrock",
        displayName: "Claude 3 Haiku (Bedrock)",
        supportsTools: true,
      },
      {
        id: "global.anthropic.claude-sonnet-5",
        provider: "bedrock",
        displayName: "Global Claude Sonnet 5 (Bedrock)",
        supportsTools: true,
      },
    ];

    expect(recommendedModelCandidates(models)[0]?.id).toBe(
      "global.anthropic.claude-sonnet-5",
    );
  });
});
