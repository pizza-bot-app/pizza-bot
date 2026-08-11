/** OpenRouter provider backed by the native LangChain `ChatOpenRouter` integration. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ModelDescriptor,
  ModelProvider,
  ProviderAuthMethod,
  ResolvedProviderConfig,
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

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_SITE_NAME = "Pizza Bot";
const FETCH_TIMEOUT_MS = 5_000;

interface OpenRouterModel {
  id?: string;
  name?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  };
  supported_parameters?: string[];
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  siteUrl?: string;
  siteName?: string;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
}

class OpenRouterBuildError extends Error {
  constructor(message: string, readonly code: "AUTH_EXPIRED") {
    super(message);
    this.name = "OpenRouterBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "OpenRouter API key", type: "password", required: true },
      {
        key: "maxTokens",
        label: "Output token budget",
        type: "text",
        required: false,
        default: String(DEFAULT_MAX_TOKENS),
      },
      {
        key: "siteUrl",
        label: "App URL",
        type: "text",
        required: false,
      },
      {
        key: "siteName",
        label: "App name",
        type: "text",
        required: false,
        default: DEFAULT_SITE_NAME,
      },
    ],
  },
];

export class OpenRouterLangChainModelProvider implements ModelProvider {
  readonly id = "openrouter";
  readonly authSchema = AUTH_SCHEMA;
  private readonly baseUrl: string;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private maxTokens: number;
  private siteUrl: string | undefined;
  private siteName: string;

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.maxTokens = positiveInteger(opts.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.siteUrl = opts.siteUrl?.trim() || undefined;
    this.siteName = opts.siteName?.trim() || DEFAULT_SITE_NAME;
    this.models = opts.models;
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    const key = cfg.values.apiKey?.trim();
    if (key) this.apiKey = key;
    this.maxTokens = positiveInteger(cfg.values.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.siteUrl = cfg.values.siteUrl?.trim() || undefined;
    this.siteName = cfg.values.siteName?.trim() || DEFAULT_SITE_NAME;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw missingCatalogCredentials("OpenRouter");

    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: this.headers(apiKey),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw catalogHttpError("OpenRouter", response.status);
      const body = (await response.json()) as OpenRouterModelsResponse;
      const discovered = (body.data ?? []).flatMap((model) => {
        if (!model.id || !supportsChat(model)) return [];
        const contextWindow = positiveInteger(model.context_length);
        const maxOutputTokens = positiveInteger(model.top_provider?.max_completion_tokens);
        return [{
          id: model.id,
          provider: "openrouter",
          displayName: `${model.name?.trim() || model.id} (OpenRouter)`,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(model.supported_parameters
            ? { supportsTools: model.supported_parameters.includes("tools") }
            : {}),
          ...(model.architecture?.input_modalities
            ? { supportsVision: model.architecture.input_modalities.includes("image") }
            : {}),
        }];
      });
      const descriptors = await enrichModelDescriptors(
        discovered,
        "openrouter",
        this.modelsDev,
      );
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("OpenRouter", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const { ChatOpenRouter } = await import("@langchain/openrouter");
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new OpenRouterBuildError(
        "No OpenRouter API key configured (set OPENROUTER_API_KEY).",
        "AUTH_EXPIRED",
      );
    }
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    const advertisedMax = descriptor?.maxOutputTokens;
    const maxTokens = Math.min(
      this.maxTokens,
      advertisedMax ?? Number.POSITIVE_INFINITY,
    );

    class ContextAwareChatOpenRouter extends ChatOpenRouter {
      override get profile() {
        return withContextWindow(super.profile, descriptor?.contextWindow);
      }
    }

    return new ContextAwareChatOpenRouter({
      model: modelId,
      apiKey,
      baseURL: this.baseUrl,
      maxTokens,
      siteName: this.siteName,
      ...(this.siteUrl ? { siteUrl: this.siteUrl } : {}),
    });
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey ?? process.env.OPENROUTER_API_KEY;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "x-title": this.siteName,
      ...(this.siteUrl ? { "http-referer": this.siteUrl } : {}),
    };
  }
}

function supportsChat(model: OpenRouterModel): boolean {
  const inputs = model.architecture?.input_modalities;
  const outputs = model.architecture?.output_modalities;
  return (!inputs || inputs.includes("text")) && (!outputs || outputs.includes("text"));
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
