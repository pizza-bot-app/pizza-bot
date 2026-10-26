/** Cheaper Inference provider backed by the OpenAI-compatible Chat Completions model. */
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
import {
  catalogConnectionError,
  catalogHttpError,
  missingCatalogCredentials,
} from "../catalog-error.js";
import { createOpenAiChatModel } from "./openai.js";

const DEFAULT_BASE_URL = "https://api.cheaperinference.com/v1";
const DEFAULT_MAX_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;

interface CheaperInferenceModel {
  id?: string;
  type?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: {
    vision?: boolean;
  };
}

interface CheaperInferenceModelsResponse {
  data?: CheaperInferenceModel[];
}

export interface CheaperInferenceProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
}

class CheaperInferenceBuildError extends Error {
  constructor(message: string, readonly code: "AUTH_EXPIRED") {
    super(message);
    this.name = "CheaperInferenceBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "Cheaper Inference API key", type: "password", required: true },
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

export class CheaperInferenceLangChainModelProvider implements ModelProvider {
  readonly id = "cheaperinference";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;

  constructor(opts: CheaperInferenceProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.maxTokens = positiveInteger(opts.maxTokens) ?? DEFAULT_MAX_TOKENS;
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
    this.baseUrl = cfg.values.baseUrl?.trim() || undefined;
    if (!this.models) this.descriptors.clear();
  }

  /** Lists the text chat models the key can use. */
  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw missingCatalogCredentials("Cheaper Inference");

    try {
      const catalog = await this.fetchModels("/models", apiKey);
      const seen = new Set<string>();
      const discovered = catalog.flatMap((model) => {
        if (!model.id || seen.has(model.id) || (model.type && model.type !== "text")) return [];
        seen.add(model.id);
        const contextWindow = positiveInteger(model.context_length);
        const maxOutputTokens = positiveInteger(model.max_output_tokens);
        return [{
          id: model.id,
          provider: "cheaperinference",
          displayName: `${model.id} (Cheaper Inference)`,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(model.capabilities?.vision !== undefined
            ? { supportsVision: model.capabilities.vision }
            : {}),
        }];
      });
      const descriptors = await enrichModelDescriptors(
        discovered,
        "cheaperinference",
        this.modelsDev,
      );
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("Cheaper Inference", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new CheaperInferenceBuildError(
        "No Cheaper Inference API key configured (set CHEAPER_INFERENCE_API_KEY).",
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

  private async fetchModels(path: string, apiKey: string): Promise<CheaperInferenceModel[]> {
    const response = await this.fetchFn(`${this.resolveBaseUrl()}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw catalogHttpError("Cheaper Inference", response.status);
    const body = (await response.json()) as CheaperInferenceModelsResponse;
    return body.data ?? [];
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey || process.env.CHEAPER_INFERENCE_API_KEY || undefined;
  }

  private resolveBaseUrl(): string {
    const baseUrl = this.baseUrl || process.env.CHEAPER_INFERENCE_BASE_URL || DEFAULT_BASE_URL;
    return baseUrl.replace(/\/$/, "");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
