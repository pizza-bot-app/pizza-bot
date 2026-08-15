/** Google Gemini provider backed by the unified `ChatGoogle` integration. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import type {
  ModelBuildOptions,
  ModelDescriptor,
  ModelProvider,
  ProviderAuthMethod,
  ResolvedProviderConfig,
} from "@pizza-bot/core";
import {
  convertGoogleChunksToEvents,
  prepareGoogleMessages,
} from "./google-tool-call-fix.js";
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
  readonly authSchema = AUTH_SCHEMA;
  private readonly aiApiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private maxOutputTokens: number;
  private platform: GooglePlatformSetting;
  private detectedPlatform: GooglePlatform | undefined;

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

  async buildModel(
    modelId: string,
    options: ModelBuildOptions = {},
  ): Promise<BaseChatModel> {
    try {
      return await this.construct(modelId, options);
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

  private async construct(
    modelId: string,
    options: ModelBuildOptions,
  ): Promise<BaseChatModel> {
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
        return withContextWindow(
          super.profile,
          options.contextWindow ?? descriptor?.contextWindow,
        );
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
      if (models) return { platform: "gai", models };
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
  if (status === 401 || status === 403) return "AUTH_EXPIRED";
  if (status === 429) return "RATE_LIMIT";
  const message =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalized = message.toLowerCase();
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
