/** Anthropic-direct provider backed by lazy-loaded `ChatAnthropic`. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ModelBuildOptions,
  ModelProvider,
  ModelDescriptor,
  ResolvedProviderConfig,
  ProviderAuthMethod,
} from "@pizza-bot/core";
import {
  enrichModelDescriptors,
  resolveModelsDevCatalog,
  type ModelsDevCatalogLoader,
} from "../models-dev.js";
import { withContextWindow } from "../model-profile.js";
import {
  catalogConnectionError,
  catalogHttpError,
  missingCatalogCredentials,
} from "../catalog-error.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const FETCH_TIMEOUT_MS = 5_000;

export type AnthropicAuthMode = "api-key" | "bearer";

interface AnthropicModelsResponse {
  data?: Array<{ id?: string; display_name?: string }>;
}

/** Preserve output headroom when adaptive thinking consumes part of the budget. */
export function resolveMaxTokens(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const env = Number(process.env.PIZZA_MAX_TOKENS);
  return Number.isFinite(env) && env > 0 ? env : 8192;
}

/** Translate Anthropic status and message fields to the recovery taxonomy. */
export function translateAnthropicError(err: unknown): "AUTH_EXPIRED" | "RATE_LIMIT" | undefined {
  const status = statusOf(err);
  if (status === 401 || status === 403) return "AUTH_EXPIRED";
  if (status === 429) return "RATE_LIMIT";
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.name, err.message);
  else if (typeof err === "string") parts.push(err);
  const m = parts.join(" ").toLowerCase();
  if (
    m.includes("authentication") ||
    m.includes("invalid api key") ||
    m.includes("invalid x-api-key") ||
    m.includes("unauthorized") ||
    m.includes("permission")
  ) {
    return "AUTH_EXPIRED";
  }
  if (m.includes("rate limit") || m.includes("overloaded") || m.includes("too many requests")) {
    return "RATE_LIMIT";
  }
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  models?: ModelDescriptor[];
  maxTokens?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
  authMode?: AnthropicAuthMode;
  catalogProvider?: string;
}

class AnthropicBuildError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH_EXPIRED" | "RATE_LIMIT",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AnthropicBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      {
        key: "apiKey",
        label: "API key or bearer token",
        type: "password",
        required: true,
      },
      { key: "baseUrl", label: "Base URL", type: "text", required: false },
      {
        key: "authMode",
        label: "Authentication",
        type: "select",
        required: false,
        default: "api-key",
        options: [
          { value: "api-key", label: "API key (x-api-key)" },
          { value: "bearer", label: "Bearer token (Authorization)" },
        ],
      },
      {
        key: "catalogProvider",
        label: "models.dev provider",
        type: "text",
        required: false,
      },
    ],
  },
];

export class AnthropicLangChainModelProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly maxTokens: number;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private authMode: AnthropicAuthMode;
  private catalogProvider: string | undefined;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.models = opts.models;
    this.maxTokens = resolveMaxTokens(opts.maxTokens);
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    this.apiKey = opts.apiKey;
    this.authMode = opts.authMode ?? "api-key";
    this.catalogProvider = opts.catalogProvider;
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    const key = cfg.values.apiKey?.trim();
    if (key) this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(cfg.values.baseUrl);
    this.authMode = cfg.values.authMode === "bearer" ? "bearer" : "api-key";
    this.catalogProvider = cfg.values.catalogProvider?.trim() || undefined;
    if (!this.models) this.descriptors.clear();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw missingCatalogCredentials("Anthropic");
    const baseUrl = this.resolvedBaseUrl();
    const catalog = modelCatalogRequest(baseUrl, this.authHeaders(apiKey));

    try {
      const response = await this.fetchFn(catalog.url, {
        headers: catalog.headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw catalogHttpError("Anthropic", response.status);
      const body = (await response.json()) as AnthropicModelsResponse;
      const discovered = (body.data ?? []).flatMap((model) => {
        if (!model.id) return [];
        return [{
          id: model.id,
          provider: "anthropic",
          displayName: `${model.display_name ?? model.id} (Anthropic)`,
          supportsTools: true,
          supportsVision: true,
        }];
      });
      const descriptors = await enrichModelDescriptors(
        discovered,
        this.catalogProvider ?? "anthropic",
        this.modelsDev,
      );
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("Anthropic", cause);
    }
  }

  async buildModel(
    modelId: string,
    options: ModelBuildOptions = {},
  ): Promise<BaseChatModel> {
    try {
      return await this.construct(modelId, options);
    } catch (err) {
      const code = translateAnthropicError(err);
      if (code)
        throw new AnthropicBuildError(err instanceof Error ? err.message : String(err), code, { cause: err });
      throw err;
    }
  }

  private async construct(
    modelId: string,
    options: ModelBuildOptions,
  ): Promise<BaseChatModel> {
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AnthropicBuildError("No Anthropic API key configured (set ANTHROPIC_API_KEY).", "AUTH_EXPIRED");
    }
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    return createAnthropicChatModel({
      modelId,
      apiKey,
      maxTokens: this.maxTokens,
      baseUrl: this.resolvedBaseUrl(),
      authMode: this.authMode,
      fetch: this.fetchFn,
      ...(options.contextWindow !== undefined
        ? { contextWindow: options.contextWindow }
        : {}),
      ...(descriptor ? { descriptor } : {}),
    });
  }

  private resolvedBaseUrl(): string {
    return this.baseUrl ??
      normalizeBaseUrl(process.env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_API_URL) ??
      DEFAULT_BASE_URL;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    return {
      "anthropic-version": "2023-06-01",
      ...(this.authMode === "bearer"
        ? { authorization: `Bearer ${apiKey}` }
        : { "x-api-key": apiKey }),
    };
  }
}

export interface AnthropicChatModelOptions {
  modelId: string;
  apiKey: string;
  maxTokens: number;
  baseUrl: string;
  authMode: AnthropicAuthMode;
  descriptor?: ModelDescriptor;
  contextWindow?: number;
  fetch?: typeof fetch;
}

export async function createAnthropicChatModel(
  options: AnthropicChatModelOptions,
): Promise<BaseChatModel> {
  const { ChatAnthropic } = await import("@langchain/anthropic");
  const {
    modelId,
    apiKey,
    maxTokens,
    baseUrl,
    authMode,
    descriptor,
    contextWindow,
    fetch: fetchFn,
  } = options;
  const defaultHeaders = authMode === "bearer"
    ? {
        authorization: `Bearer ${apiKey}`,
        "x-api-key": null,
      }
    : undefined;

  class ContextAwareChatAnthropic extends ChatAnthropic {
    override get profile() {
      return withContextWindow(
        super.profile,
        contextWindow ?? descriptor?.contextWindow,
      );
    }
  }

  return new ContextAwareChatAnthropic({
    model: modelId,
    apiKey,
    maxTokens,
    anthropicApiUrl: baseUrl,
    ...((defaultHeaders || fetchFn)
      ? {
          clientOptions: {
            ...(defaultHeaders ? { defaultHeaders } : {}),
            ...(fetchFn ? { fetch: fetchFn } : {}),
          },
        }
      : {}),
  });
}

export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 0x2f) end -= 1;
  const baseUrl = trimmed.slice(0, end);
  if (!baseUrl) return undefined;
  return baseUrl.replace(/\/v1\/messages$/i, "");
}

function modelCatalogRequest(
  baseUrl: string,
  defaultHeaders: Record<string, string>,
): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: `${baseUrl}/v1/models?limit=1000`,
    headers: defaultHeaders,
  };
}
