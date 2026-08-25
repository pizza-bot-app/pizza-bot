/** Provider-agnostic registry keyed by `provider:model`. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ErrorCode } from "./protocol-types.js";

export interface ModelDescriptor {
  id: string;
  provider: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export type ModelCatalogErrorCode =
  | "credentials"
  | "authentication"
  | "network"
  | "endpoint"
  | "unavailable";

export class ModelCatalogError extends Error {
  constructor(
    readonly code: ModelCatalogErrorCode,
    message: string,
    readonly retryable = true,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModelCatalogError";
  }
}

export type ModelCatalogStatus =
  | {
      provider: string;
      status: "ready";
      modelCount: number;
      stale: false;
    }
  | {
      provider: string;
      /** Some models were listed, but at least one catalog source failed. */
      status: "degraded";
      modelCount: number;
      stale: boolean;
      code: ModelCatalogErrorCode;
      message: string;
      retryable: boolean;
    }
  | {
      provider: string;
      status: "error";
      modelCount: number;
      stale: boolean;
      code: ModelCatalogErrorCode;
      message: string;
      retryable: boolean;
    };

/**
 * Reported by providers that fan out to several catalog APIs, so one failing
 * source degrades loudly instead of silently shrinking the model list.
 */
export interface ModelCatalogDegradation {
  code: ModelCatalogErrorCode;
  message: string;
  retryable: boolean;
  /** Some listed models come from an earlier response rather than this one. */
  stale: boolean;
}

export interface ModelCatalogSnapshot {
  models: ModelDescriptor[];
  providers: ModelCatalogStatus[];
}

/**
 * Product-level preference for automatic selection. This deliberately favors
 * balanced agent models over premium/fast variants; provider catalog order is
 * never used as a recommendation signal.
 */
export function recommendedModelCandidates(
  models: readonly ModelDescriptor[],
): ModelDescriptor[] {
  return models
    .filter((model) => model.supportsTools !== false)
    .map((model) => ({ model, score: recommendationScore(model) }))
    .sort((a, b) =>
      b.score - a.score ||
      bedrockGlobalPreference(b.model) - bedrockGlobalPreference(a.model) ||
      qualifiedModelId(a.model).localeCompare(qualifiedModelId(b.model))
    )
    .map(({ model }) => model);
}

export interface AutomaticModelCatalog {
  /** Recommendation order, led by the remembered pick on an incomplete catalog. */
  ids: string[];
  /** The catalog may be trusted to record a new automatic default. */
  complete: boolean;
  /** Set when the remembered pick leads because the catalog is incomplete. */
  keeping?: string;
}

/**
 * Candidate order for automatic selection. A catalog missing models it should
 * have keeps the remembered pick rather than resolving a different default.
 */
export async function automaticModelCatalog(
  registry: Pick<ModelRegistry, "listCatalog" | "isModelEnabled">,
  remembered?: string,
): Promise<AutomaticModelCatalog> {
  const snapshot = await registry.listCatalog();
  const ids = recommendedModelCandidates(snapshot.models).map(qualifiedModelId);
  const complete =
    ids.length > 0 &&
    snapshot.providers.every(providerCatalogIsComplete) &&
    mayReplaceRemembered(snapshot.providers, remembered);
  if (complete || !remembered || !registry.isModelEnabled(remembered)) {
    return { ids, complete };
  }
  return {
    ids: [remembered, ...ids.filter((id) => id !== remembered)],
    complete,
    keeping: remembered,
  };
}

/**
 * Most installations leave several providers unconfigured, so a provider that
 * lists nothing is normal and has nothing to lose. One serving a partial or
 * last-known list is what makes the catalog too incomplete to re-pick from.
 */
function providerCatalogIsComplete(status: ModelCatalogStatus): boolean {
  return status.status === "ready" || status.modelCount === 0;
}

/**
 * A provider whose own listing failed may simply be hiding the remembered
 * model, so only a ready provider — or one holding no credentials at all, which
 * voids the pick — may resolve a different default.
 */
function mayReplaceRemembered(
  statuses: readonly ModelCatalogStatus[],
  remembered: string | undefined,
): boolean {
  if (!remembered) return true;
  const provider = remembered.slice(0, remembered.indexOf(":"));
  const status = statuses.find((candidate) => candidate.provider === provider);
  if (!status || status.status === "ready") return true;
  return status.code === "credentials" && status.modelCount === 0;
}

function bedrockGlobalPreference(model: ModelDescriptor): number {
  return model.provider === "bedrock" && model.id.toLowerCase().startsWith("global.") ? 1 : 0;
}

function recommendationScore(model: ModelDescriptor): number {
  const id = `${model.id} ${model.displayName}`.toLowerCase();
  let score = 0;

  // Claude Sonnet is Pizza Bot's maintained balanced quality/cost default.
  if (id.includes("sonnet")) score = 5_000 + familyVersion(id, "sonnet");
  else if (/\bgpt[- _.]?5\b/.test(id)) score = 4_800 + familyVersion(id, "gpt");
  else if (id.includes("gemini") && id.includes("pro")) {
    score = 4_600 + familyVersion(id, "gemini");
  } else if (/\bgpt[- _.]?4(?:[._ -]?1)?\b/.test(id)) {
    score = 4_400 + familyVersion(id, "gpt");
  } else if (id.includes("gemini") && id.includes("flash")) {
    score = 4_000 + familyVersion(id, "gemini");
  } else if (id.includes("opus")) score = 3_800 + familyVersion(id, "opus");
  else if (id.includes("haiku")) score = 3_600 + familyVersion(id, "haiku");

  if (/\b(preview|experimental|exp)\b/.test(id)) score -= 100;
  return score;
}

function familyVersion(id: string, family: string): number {
  const separator = "[- _.]";
  const after = id.match(
    new RegExp(`${family}${separator}?(\\d+)(?:${separator}(\\d+))?`),
  );
  if (after && Number(after[1]) <= 99) return versionParts(after[1], after[2]);

  // Legacy Claude IDs put "3" or "3-5" before the family name.
  const before = id.match(
    new RegExp(`(\\d+)(?:${separator}(\\d+))?${separator}${family}`),
  );
  return before ? versionParts(before[1], before[2]) : 0;
}

function versionParts(major: string | undefined, minor: string | undefined): number {
  const parsedMinor = Number(minor ?? 0);
  // Date-stamped IDs use the segment after the major version for release dates.
  return Number(major ?? 0) * 100 + (parsedMinor <= 99 ? parsedMinor : 0);
}

function qualifiedModelId(model: ModelDescriptor): string {
  return `${model.provider}:${model.id}`;
}

/**
 * The generic settings form renders this schema directly. Password values must
 * never be returned raw to the browser.
 */
export interface ProviderAuthField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  required: boolean;
  options?: readonly { value: string; label: string }[];
  default?: string;
}

export interface ProviderAuthMethod {
  id: string;
  label: string;
  fields: readonly ProviderAuthField[];
}

/** Secret environment references are expanded before this reaches a provider. */
export interface ResolvedProviderConfig {
  method: string;
  values: Record<string, string>;
}

export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<ModelDescriptor[]>;
  buildModel(modelId: string): Promise<BaseChatModel>;
  readonly authSchema?: readonly ProviderAuthMethod[];
  /** The provider can use ambient credentials or defaults without saved config. */
  readonly availableWithoutConfig?: boolean;
  /** Set when the given listing was served with at least one source missing. */
  catalogDegradation?(
    models: readonly ModelDescriptor[],
  ): ModelCatalogDegradation | undefined;
  /** Applies persisted configuration at registration and on later settings updates. */
  configure?(cfg: ResolvedProviderConfig): void;
  /**
   * Environment propagated to stdio MCP subprocesses so tools can reuse provider
   * credentials. Later providers win when keys collide.
   */
  processEnv?(): Record<string, string>;
}

/**
 * Explicitly requested models fail rather than silently falling back.
 * `cause` retains provider failures for actionable error classification.
 */
export class ModelUnavailableError extends Error {
  /**
   * Provider failures may override `MODEL_UNAVAILABLE` with a more actionable
   * taxonomy code such as `AUTH_EXPIRED`.
   */
  readonly code: ErrorCode;
  readonly modelId: string;
  readonly reason: "unregistered-provider" | "build-failed" | "malformed-id";
  constructor(
    modelId: string,
    reason: ModelUnavailableError["reason"],
    message: string,
    options?: { cause?: unknown; code?: ErrorCode },
  ) {
    super(message, options);
    this.name = "ModelUnavailableError";
    this.modelId = modelId;
    this.reason = reason;
    this.code = options?.code ?? "MODEL_UNAVAILABLE";
  }
}

export type ModelAvailability =
  | {
      available: true;
      provider: string;
      modelId: string;
      /** Catalog metadata is optional; registered providers may build other IDs. */
      descriptor?: ModelDescriptor;
    }
  | {
      available: false;
      reason: "unregistered-provider" | "malformed-id";
      message: string;
    };

export class ModelRegistry {
  private providers = new Map<string, ModelProvider>();
  private catalog:
    | { snapshot: ModelCatalogSnapshot; expiresAt: number }
    | undefined;
  private catalogInFlight:
    | { generation: number; promise: Promise<ModelCatalogSnapshot> }
    | undefined;
  private catalogGeneration = 0;
  private lastGoodModels = new Map<string, ModelDescriptor[]>();
  private enabledModels = new Map<string, Set<string>>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
    this.catalog = undefined;
    this.catalogGeneration += 1;
  }

  configureProvider(providerId: string, config: ResolvedProviderConfig): boolean {
    const provider = this.providers.get(providerId);
    if (!provider?.configure) return false;
    provider.configure(config);
    this.catalog = undefined;
    this.catalogGeneration += 1;
    return true;
  }

  setEnabledModels(providerId: string, modelIds: readonly string[] | undefined): void {
    if (modelIds === undefined) this.enabledModels.delete(providerId);
    else this.enabledModels.set(providerId, new Set(modelIds));
  }

  /** Preference-filtered availability for callers that bypass `listCatalog`. */
  isModelEnabled(qualified: string): boolean {
    const parsed = this.parse(qualified);
    if (!parsed) return false;
    const enabled = this.enabledModels.get(parsed.provider);
    return enabled === undefined || enabled.has(parsed.modelId);
  }

  private parse(qualified: string): { provider: string; modelId: string } | undefined {
    const idx = qualified.indexOf(":");
    if (idx <= 0 || idx === qualified.length - 1) return undefined;
    return { provider: qualified.slice(0, idx), modelId: qualified.slice(idx + 1) };
  }

  async buildModel(qualified: string): Promise<BaseChatModel> {
    const parsed = this.parse(qualified);
    if (!parsed) throw new Error(`Model id "${qualified}" must be "provider:model".`);
    const p = this.providers.get(parsed.provider);
    if (!p) throw new Error(`No model provider registered for "${parsed.provider}".`);
    return p.buildModel(parsed.modelId);
  }

  async validate(qualified: string): Promise<ModelAvailability> {
    const parsed = this.parse(qualified);
    if (!parsed) {
      return { available: false, reason: "malformed-id", message: `Model id "${qualified}" must be "provider:model".` };
    }
    const p = this.providers.get(parsed.provider);
    if (!p) {
      return {
        available: false,
        reason: "unregistered-provider",
        message: `No model provider registered for "${parsed.provider}".`,
      };
    }
    // Discovery is advisory and may itself be unavailable for remote providers.
    const descriptor = (await p.listModels().catch(() => [])).find((d) => d.id === parsed.modelId);
    return {
      available: true,
      provider: parsed.provider,
      modelId: parsed.modelId,
      ...(descriptor ? { descriptor } : {}),
    };
  }

  /**
   * Validates explicit selections before building and never falls back silently.
   * Use `buildModel` for the host's fallback-friendly default path.
   */
  async resolveModel(qualified: string): Promise<BaseChatModel> {
    const check = await this.validate(qualified);
    if (!check.available) {
      throw new ModelUnavailableError(qualified, check.reason, check.message);
    }
    const p = this.providers.get(check.provider)!;
    try {
      return await p.buildModel(check.modelId);
    } catch (err) {
      const code = codeOf(err);
      throw new ModelUnavailableError(
        qualified,
        "build-failed",
        `Model "${qualified}" is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err, ...(code ? { code } : {}) },
      );
    }
  }

  async listAll(options: { includeDisabled?: boolean } = {}): Promise<ModelDescriptor[]> {
    return (await this.listCatalog(options)).models;
  }

  async listCatalog(
    options: { includeDisabled?: boolean; refresh?: boolean } = {},
  ): Promise<ModelCatalogSnapshot> {
    const snapshot = await this.loadCatalog(options.refresh === true);
    const models = options.includeDisabled
      ? snapshot.models
      : snapshot.models.filter((model) => {
          const enabled = this.enabledModels.get(model.provider);
          return enabled === undefined || enabled.has(model.id);
        });
    return { models, providers: snapshot.providers };
  }

  private async loadCatalog(refresh: boolean): Promise<ModelCatalogSnapshot> {
    if (!refresh && this.catalog && this.catalog.expiresAt > Date.now()) {
      return this.catalog.snapshot;
    }
    const generation = this.catalogGeneration;
    if (this.catalogInFlight?.generation === generation) {
      return this.catalogInFlight.promise;
    }

    const promise = Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          const models = await provider.listModels();
          const degradation = provider.catalogDegradation?.(models);
          if (degradation) {
            // A partial catalog must never become the last-good baseline.
            return {
              models,
              fresh: false,
              status: {
                provider: provider.id,
                status: "degraded",
                modelCount: models.length,
                stale: degradation.stale,
                code: degradation.code,
                message: degradation.message,
                retryable: degradation.retryable,
              } satisfies ModelCatalogStatus,
            };
          }
          return {
            models,
            fresh: true,
            status: {
              provider: provider.id,
              status: "ready",
              modelCount: models.length,
              stale: false,
            } satisfies ModelCatalogStatus,
          };
        } catch (cause) {
          const error = catalogError(cause);
          const models = this.lastGoodModels.get(provider.id) ?? [];
          return {
            models,
            fresh: false,
            status: {
              provider: provider.id,
              status: "error",
              modelCount: models.length,
              stale: models.length > 0,
              code: error.code,
              message: error.message,
              retryable: error.retryable,
            } satisfies ModelCatalogStatus,
          };
        }
      }),
    )
      .then((rows) => {
        const snapshot = {
          models: rows.flatMap((row) => row.models),
          providers: rows.map((row) => row.status),
        };
        if (this.catalogGeneration === generation) {
          for (const row of rows) {
            if (row.fresh) this.lastGoodModels.set(row.status.provider, row.models);
          }
          this.catalog = { snapshot, expiresAt: Date.now() + 30_000 };
        }
        return snapshot;
      })
      .finally(() => {
        if (this.catalogInFlight?.promise === promise) {
          this.catalogInFlight = undefined;
        }
      });

    this.catalogInFlight = { generation, promise };
    return promise;
  }

  collectProcessEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.providers.values()) Object.assign(out, p.processEnv?.() ?? {});
    return out;
  }

  listProviders(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => {
      const configurable = (p.authSchema?.length ?? 0) > 0;
      return {
        id: p.id,
        configurable,
        availableWithoutConfig: !configurable || p.availableWithoutConfig === true,
        ...(p.authSchema ? { authSchema: p.authSchema } : {}),
      };
    });
  }
}

function catalogError(cause: unknown): ModelCatalogError {
  if (cause instanceof ModelCatalogError) return cause;
  return new ModelCatalogError(
    "unavailable",
    "Model catalog discovery failed.",
    true,
    { cause },
  );
}

export interface ProviderInfo {
  id: string;
  configurable: boolean;
  availableWithoutConfig: boolean;
  authSchema?: readonly ProviderAuthMethod[];
}

function codeOf(err: unknown): ErrorCode | undefined {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code as ErrorCode;
  }
  return undefined;
}

/** Selection precedence: conversation, global, then best available. */
export function selectModel(opts: {
  conversationOverride?: string | null;
  globalDefault?: string | null;
  bestAvailable?: string | null;
}): string {
  const chosen =
    opts.conversationOverride ??
    opts.globalDefault ??
    opts.bestAvailable;
  if (!chosen) throw new Error("No model available: selection cascade exhausted.");
  return chosen;
}
