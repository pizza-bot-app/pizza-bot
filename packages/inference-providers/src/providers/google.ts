/** Google Gemini provider backed by the unified `ChatGoogle` integration. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import type {
  ModelDescriptor,
  ModelProvider,
  ProviderAuthMethod,
  ResolvedProviderConfig,
} from "@pizza-bot/core";
import {
  convertGoogleChunksToEvents,
  prepareGoogleMessages,
} from "./google-tool-call-fix.js";
import { sanitizeGeminiTools } from "./google-schema-fix.js";
import {
  enrichModelDescriptor,
  resolveModelsDevCatalog,
  type ModelsDevCatalogLoader,
  type ModelsDevModel,
} from "../models-dev.js";
import { withContextWindow } from "../model-profile.js";
import {
  catalogConnectionError,
  missingCatalogCredentials,
} from "../catalog-error.js";

const DEFAULT_AI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CATALOG_PAGES = 10;
const VERTEX_FALLBACK_MODEL = "gemini-2.5-flash";

const PLATFORM_LABELS: Record<GooglePlatform, string> = {
  gai: "Google AI Studio",
  gcp: "Vertex AI Express",
};

type GooglePlatform = "gai" | "gcp";
type GooglePlatformSetting = GooglePlatform | "auto";

interface GoogleModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GoogleModelsResponse {
  models?: GoogleModel[];
  nextPageToken?: string;
}

interface DiscoveryResult {
  platform: GooglePlatform;
  models: ModelDescriptor[];
}

export interface GoogleProviderOptions {
  apiKey?: string;
  /** Backwards-compatible alias for `aiApiBase`. */
  apiBase?: string;
  aiApiBase?: string;
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
  maxOutputTokens?: number;
  platform?: GooglePlatformSetting;
  models?: ModelDescriptor[];
}

class GoogleBuildError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH_EXPIRED" | "RATE_LIMIT",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GoogleBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "Google API key", type: "password", required: true },
      {
        key: "platform",
        label: "Platform",
        type: "select",
        required: true,
        default: "auto",
        options: [
          { value: "auto", label: "Auto-detect" },
          { value: "gai", label: "Google AI Studio" },
          { value: "gcp", label: "Vertex AI Express" },
        ],
      },
      {
        key: "maxOutputTokens",
        label: "Output token budget",
        type: "text",
        required: false,
        default: String(DEFAULT_MAX_OUTPUT_TOKENS),
      },
    ],
  },
];

export class GoogleLangChainModelProvider implements ModelProvider {
  readonly id = "google";
  private readonly aiApiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private maxOutputTokens: number;
  private platform: GooglePlatformSetting;
  private detectedPlatform: GooglePlatform | undefined;
  private aiStudioGeneration: Promise<boolean> | undefined;

  /** Auto-detect reports which platform it settled on; the field is otherwise silent about it. */
  get authSchema(): readonly ProviderAuthMethod[] {
    const detected = this.detectedPlatform;
    if (!detected || this.platform !== "auto") return AUTH_SCHEMA;
    return AUTH_SCHEMA.map((method) => ({
      ...method,
      fields: method.fields.map((field) =>
        field.key === "platform" && field.options
          ? {
              ...field,
              options: field.options.map((option) =>
                option.value === "auto"
                  ? { ...option, label: `${option.label} (using ${PLATFORM_LABELS[detected]})` }
                  : option,
              ),
            }
          : field,
      ),
    }));
  }

  constructor(opts: GoogleProviderOptions = {}) {
    this.aiApiBase = (
      opts.aiApiBase ??
      opts.apiBase ??
      DEFAULT_AI_API_BASE
    ).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    this.models = opts.models;
    this.apiKey = opts.apiKey;
    this.maxOutputTokens =
      positiveInteger(opts.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.platform = validPlatform(opts.platform) ?? "auto";
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    const key = cfg.values.apiKey?.trim();
    if (key) this.apiKey = key;
    this.maxOutputTokens =
      positiveInteger(cfg.values.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.platform = validPlatform(cfg.values.platform) ?? "auto";
    this.detectedPlatform = undefined;
    this.aiStudioGeneration = undefined;
    if (!this.models) this.descriptors.clear();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw missingCatalogCredentials("Google");

    try {
      const result = await this.discover(apiKey);
      if (!result) return [];
      this.detectedPlatform = result.platform;
      this.descriptors.clear();
      for (const descriptor of result.models) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return result.models;
    } catch (cause) {
      throw catalogConnectionError("Google", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    try {
      return await this.construct(modelId);
    } catch (error) {
      const code = translateGoogleError(error);
      if (code) {
        throw new GoogleBuildError(
          error instanceof Error ? error.message : String(error),
          code,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async construct(modelId: string): Promise<BaseChatModel> {
    const { ChatGoogle } = await import("@langchain/google/node");
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new GoogleBuildError(
        "No Google API key configured (set GOOGLE_API_KEY or GEMINI_API_KEY).",
        "AUTH_EXPIRED",
      );
    }
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const platform = await this.platformForBuild(apiKey);
    const descriptor = this.descriptors.get(modelId);
    const advertisedMax = descriptor?.maxOutputTokens;
    const maxOutputTokens = Math.min(
      this.maxOutputTokens,
      advertisedMax ?? Number.POSITIVE_INFINITY,
    );
    class ThoughtSignatureSafeChatGoogle extends ChatGoogle {
      override get profile() {
        return withContextWindow(super.profile, descriptor?.contextWindow);
      }

      override invocationParams(options: this["ParsedCallOptions"]) {
        const params = super.invocationParams(options);
        if (!params.tools) return params;
        return { ...params, tools: sanitizeGeminiTools(params.tools) };
      }

      override async _generate(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): Promise<ChatResult> {
        return super._generate(
          prepareGoogleMessages(messages),
          options,
          runManager,
        );
      }

      override async *_streamResponseChunks(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): AsyncGenerator<ChatGenerationChunk> {
        yield* super._streamResponseChunks(
          prepareGoogleMessages(messages),
          options,
          runManager,
        );
      }

      override async *_streamChatModelEvents(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): AsyncGenerator<ChatModelStreamEvent> {
        yield* convertGoogleChunksToEvents(
          super._streamResponseChunks(
            prepareGoogleMessages(messages),
            options,
            runManager,
          ),
        );
      }
    }

    return new ThoughtSignatureSafeChatGoogle({
      model: modelId,
      apiKey,
      platformType: platform,
      ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
    });
  }

  private async platformForBuild(apiKey: string): Promise<GooglePlatform> {
    if (this.platform !== "auto") return this.platform;
    if (this.detectedPlatform) return this.detectedPlatform;
    if (this.models) return "gai";
    const result = await this.discover(apiKey);
    if (!result) {
      throw new GoogleBuildError(
        "The Google API key was not accepted by Google AI Studio or Vertex AI Express.",
        "AUTH_EXPIRED",
      );
    }
    this.detectedPlatform = result.platform;
    for (const descriptor of result.models) {
      this.descriptors.set(descriptor.id, descriptor);
    }
    return result.platform;
  }

  private async discover(apiKey: string): Promise<DiscoveryResult | undefined> {
    if (this.platform !== "gcp") {
      const models = await this.discoverAiModels(apiKey);
      // An explicit choice is honored as given; only auto-detect needs the evidence.
      if (models && this.platform === "gai") return { platform: "gai", models };
      if (models && (await this.aiStudioCanGenerate(apiKey, models))) {
        return { platform: "gai", models };
      }
      if (this.platform === "gai") return undefined;
    }

    const models = await this.discoverModelsDev("google-vertex");
    return {
      platform: "gcp",
      models:
        models.length > 0
          ? models
          : [
              {
                id: VERTEX_FALLBACK_MODEL,
                provider: "google",
                displayName: `${VERTEX_FALLBACK_MODEL} (Google)`,
                supportsTools: true,
                supportsVision: true,
              },
            ],
    };
  }

  private async discoverAiModels(
    apiKey: string,
  ): Promise<ModelDescriptor[] | undefined> {
    const discovered: ModelDescriptor[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const url = new URL(`${this.aiApiBase}/v1beta/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetchFn(url, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as GoogleModelsResponse;
      for (const model of body.models ?? []) {
        const descriptor = googleModelDescriptor(model);
        if (descriptor) discovered.push(descriptor);
      }
      pageToken = body.nextPageToken?.trim() || undefined;
      if (!pageToken) break;
    }
    return uniqueModels(discovered);
  }

  /**
   * Listing models proves only that the key is known to AI Studio, not that the
   * platform will serve a generation — depleted prepay credits and a key blocked
   * for the API both list fine and then fail every run.
   */
  private async aiStudioCanGenerate(
    apiKey: string,
    models: readonly ModelDescriptor[],
  ): Promise<boolean> {
    this.aiStudioGeneration ??= this.probeAiGeneration(apiKey, models);
    return this.aiStudioGeneration;
  }

  private async probeAiGeneration(
    apiKey: string,
    models: readonly ModelDescriptor[],
  ): Promise<boolean> {
    const probe = probeModelId(models);
    if (!probe) return true;
    try {
      const response = await this.fetchFn(
        `${this.aiApiBase}/v1beta/models/${probe}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (response.ok) return true;
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      return !platformRejected(response.status, body.error?.message ?? "");
    } catch {
      // A transient failure is no evidence about the platform; keep the listing's verdict.
      return true;
    }
  }

  private async discoverModelsDev(provider: string): Promise<ModelDescriptor[]> {
    const models = await this.modelsDev.models(provider);
    return Object.entries(models ?? {})
      .flatMap(([id, model]) => {
        const descriptor = modelsDevDescriptor(id, model);
        return descriptor ? [descriptor] : [];
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private resolveApiKey(): string | undefined {
    return (
      this.apiKey ??
      process.env.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY
    );
  }
}

export function googleModelDescriptor(
  model: GoogleModel,
): ModelDescriptor | undefined {
  if (
    !model.name ||
    !model.supportedGenerationMethods?.includes("generateContent")
  ) {
    return undefined;
  }
  const id = model.name.startsWith("models/")
    ? model.name.slice("models/".length)
    : model.name;
  if (!id) return undefined;
  return {
    id,
    provider: "google",
    displayName: `${model.displayName?.trim() || id} (Google)`,
    ...(positiveInteger(model.inputTokenLimit)
      ? { contextWindow: model.inputTokenLimit }
      : {}),
    ...(positiveInteger(model.outputTokenLimit)
      ? { maxOutputTokens: model.outputTokenLimit }
      : {}),
    supportsTools: true,
    supportsVision: true,
  };
}

function modelsDevDescriptor(
  id: string,
  model: ModelsDevModel,
): ModelDescriptor | undefined {
  if (
    (!id.startsWith("gemini-") && !id.startsWith("gemma-")) ||
    id.includes("embedding") ||
    (model.modalities?.output &&
      !model.modalities.output.includes("text"))
  ) {
    return undefined;
  }
  const descriptor = enrichModelDescriptor({
    id,
    provider: "google",
    displayName: `${model.name?.trim() || id} (Google)`,
  }, model);
  return {
    ...descriptor,
    supportsTools: descriptor.supportsTools ?? true,
    supportsVision: descriptor.supportsVision ?? true,
  };
}

export function translateGoogleError(
  error: unknown,
): "AUTH_EXPIRED" | "RATE_LIMIT" | undefined {
  const status = statusOf(error);
  const message =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalized = message.toLowerCase();
  // A key blocked for the API is valid; re-authenticating cannot enable the service.
  if (serviceBlocked(normalized)) return undefined;
  if (status === 401 || status === 403) return "AUTH_EXPIRED";
  if (status === 429) return "RATE_LIMIT";
  if (
    normalized.includes("api key not valid") ||
    normalized.includes("api_key_invalid") ||
    normalized.includes("invalid api key") ||
    normalized.includes("unauthenticated") ||
    normalized.includes("permission denied")
  ) {
    return "AUTH_EXPIRED";
  }
  if (
    normalized.includes("resource_exhausted") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  ) {
    return "RATE_LIMIT";
  }
  return undefined;
}

/** Terminal for the platform, as opposed to a rate limit or a bad model id. */
function platformRejected(status: number, message: string): boolean {
  const normalized = message.toLowerCase();
  if (status === 403) return true;
  return status === 429 && /credit|billing|prepay/.test(normalized);
}

function serviceBlocked(normalized: string): boolean {
  return (
    normalized.includes("api_key_service_blocked") ||
    normalized.includes("are blocked") ||
    normalized.includes("has not been used in project") ||
    normalized.includes("it is disabled")
  );
}

/** The cheapest model available, so verifying a platform costs as little as possible. */
function probeModelId(models: readonly ModelDescriptor[]): string | undefined {
  const byPreference = ["flash-lite", "flash"];
  for (const hint of byPreference) {
    const match = models.find((model) => model.id.includes(hint));
    if (match) return match.id;
  }
  return models[0]?.id;
}

function validPlatform(value: string | undefined): GooglePlatformSetting | undefined {
  return value === "auto" || value === "gai" || value === "gcp"
    ? value
    : undefined;
}

function uniqueModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function positiveInteger(
  value: number | string | undefined,
): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
