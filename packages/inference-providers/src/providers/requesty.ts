/** Requesty provider backed by the OpenAI-compatible Chat Completions model. */
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

const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_MAX_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;

interface RequestyModel {
  id?: string;
  api?: string;
  context_window?: number;
  max_output_tokens?: number;
  supports_tool_calling?: boolean;
  supports_vision?: boolean;
}

interface RequestyModelsResponse {
  data?: RequestyModel[];
}

export interface RequestyProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
}

class RequestyBuildError extends Error {
  constructor(message: string, readonly code: "AUTH_EXPIRED") {
    super(message);
    this.name = "RequestyBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "Requesty API key", type: "password", required: true },
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

export class RequestyLangChainModelProvider implements ModelProvider {
  readonly id = "requesty";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;

  constructor(opts: RequestyProviderOptions = {}) {
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

  /** Managed policies come first, followed by the rest of the catalog the key can use. */
  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw missingCatalogCredentials("Requesty");

    try {
      const [managed, catalog] = await Promise.all([
        // Managed policies only reorder the picker; the full catalog still serves every model.
        this.fetchModels("/models/managed", apiKey).catch(() => []),
        this.fetchModels("/models", apiKey),
      ]);
      const managedIds = new Set(managed.flatMap((model) => (model.id ? [model.id] : [])));
      const seen = new Set<string>();
      const discovered = [...managed, ...catalog].flatMap((model) => {
        if (!model.id || seen.has(model.id) || (model.api && model.api !== "chat")) return [];
        seen.add(model.id);
        const contextWindow = positiveInteger(model.context_window);
        const maxOutputTokens = positiveInteger(model.max_output_tokens);
        const label = managedIds.has(model.id) ? "Requesty managed" : "Requesty";
        return [{
          id: model.id,
          provider: "requesty",
          displayName: `${model.id} (${label})`,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(model.supports_tool_calling !== undefined
            ? { supportsTools: model.supports_tool_calling }
            : {}),
          ...(model.supports_vision !== undefined
            ? { supportsVision: model.supports_vision }
            : {}),
        }];
      });
      const descriptors = await enrichModelDescriptors(
        discovered,
        "requesty",
        this.modelsDev,
      );
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("Requesty", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new RequestyBuildError(
        "No Requesty API key configured (set REQUESTY_API_KEY).",
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

  private async fetchModels(path: string, apiKey: string): Promise<RequestyModel[]> {
    const response = await this.fetchFn(`${this.resolveBaseUrl()}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw catalogHttpError("Requesty", response.status);
    const body = (await response.json()) as RequestyModelsResponse;
    return body.data ?? [];
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey || process.env.REQUESTY_API_KEY || undefined;
  }

  private resolveBaseUrl(): string {
    const baseUrl = this.baseUrl || process.env.REQUESTY_BASE_URL || DEFAULT_BASE_URL;
    return baseUrl.replace(/\/$/, "");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
