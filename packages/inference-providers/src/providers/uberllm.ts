/** UberLLM provider backed by the OpenAI-compatible Chat Completions model. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ModelDescriptor,
  ModelProvider,
  ProviderAuthMethod,
  ResolvedProviderConfig,
} from "@pizza-bot/core";
import {
  catalogConnectionError,
  catalogHttpError,
  missingCatalogCredentials,
} from "../catalog-error.js";
import { createOpenAiChatModel } from "./openai.js";

const DEFAULT_BASE_URL = "https://api.uberllm.dev/v1";
const DEFAULT_MAX_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;

interface UberLlmModel {
  id?: string;
  type?: string;
  available?: boolean;
  context_length?: number;
  max_output_tokens?: number;
  supports_tools?: boolean;
  supports_vision?: boolean;
}

interface UberLlmModelsResponse {
  data?: UberLlmModel[];
}

export interface UberLlmProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
}

class UberLlmBuildError extends Error {
  constructor(message: string, readonly code: "AUTH_EXPIRED") {
    super(message);
    this.name = "UberLlmBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "UberLLM API key", type: "password", required: true },
      {
        key: "maxTokens",
        label: "Output token budget",
        type: "text",
        required: false,
        default: String(DEFAULT_MAX_TOKENS),
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        required: false,
        default: DEFAULT_BASE_URL,
      },
    ],
  },
];

export class UberLlmLangChainModelProvider implements ModelProvider {
  readonly id = "uberllm";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;

  constructor(opts: UberLlmProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.maxTokens = positiveInteger(opts.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.models = opts.models;
    this.fetchFn = opts.fetch ?? fetch;
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    const key = cfg.values.apiKey?.trim();
    if (key) this.apiKey = key;
    this.maxTokens = positiveInteger(cfg.values.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = cfg.values.baseUrl?.trim() || undefined;
    if (!this.models) this.descriptors.clear();
  }

  /**
   * Chat models the key can use. UberLLM's listing carries context, output,
   * tool and vision metadata for each model, so no models.dev lookup is needed.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw missingCatalogCredentials("UberLLM");

    try {
      const catalog = await this.fetchModels("/models", apiKey);
      const seen = new Set<string>();
      const descriptors = catalog.flatMap((model): ModelDescriptor[] => {
        if (!model.id || seen.has(model.id)) return [];
        // Skip image/video/audio entries and models that are temporarily offline.
        if ((model.type && model.type !== "chat") || model.available === false) return [];
        seen.add(model.id);
        const contextWindow = positiveInteger(model.context_length);
        const maxOutputTokens = positiveInteger(model.max_output_tokens);
        return [{
          id: model.id,
          provider: "uberllm",
          displayName: `${model.id} (UberLLM)`,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(model.supports_tools !== undefined ? { supportsTools: model.supports_tools } : {}),
          ...(model.supports_vision !== undefined ? { supportsVision: model.supports_vision } : {}),
        }];
      });
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("UberLLM", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new UberLlmBuildError(
        "No UberLLM API key configured (set UBERLLM_API_KEY).",
        "AUTH_EXPIRED",
      );
    }
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    const configuredMax = Math.min(
      this.maxTokens,
      descriptor?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    );
    return createOpenAiChatModel({
      modelId,
      apiKey,
      maxTokens: Math.min(
        configuredMax,
        this.learnedMaxTokens.get(modelId) ?? Number.POSITIVE_INFINITY,
      ),
      apiMode: "chat-completions",
      baseUrl: this.resolveBaseUrl(),
      fetch: this.fetchFn,
      learnedMaxTokens: this.learnedMaxTokens,
      ...(descriptor ? { descriptor } : {}),
    });
  }

  private async fetchModels(path: string, apiKey: string): Promise<UberLlmModel[]> {
    const response = await this.fetchFn(`${this.resolveBaseUrl()}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw catalogHttpError("UberLLM", response.status);
    const body = (await response.json()) as UberLlmModelsResponse;
    return body.data ?? [];
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey || process.env.UBERLLM_API_KEY || undefined;
  }

  private resolveBaseUrl(): string {
    const baseUrl = this.baseUrl || process.env.UBERLLM_BASE_URL || DEFAULT_BASE_URL;
    return baseUrl.replace(/\/$/, "");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
