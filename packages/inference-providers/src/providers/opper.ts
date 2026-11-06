/** Opper provider backed by the OpenAI-compatible Chat Completions model. */
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

const DEFAULT_BASE_URL = "https://api.opper.ai/v3/compat";
const DEFAULT_MAX_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;

interface OpperModel {
  id?: string;
  context_length?: number;
  opper?: {
    kind?: string;
    type?: string;
    capabilities?: string[];
    max_output_tokens?: number;
  };
}

interface OpperModelsResponse {
  data?: OpperModel[];
}

export interface OpperProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
}

class OpperBuildError extends Error {
  constructor(message: string, readonly code: "AUTH_EXPIRED") {
    super(message);
    this.name = "OpperBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "Opper API key", type: "password", required: true },
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

export class OpperLangChainModelProvider implements ModelProvider {
  readonly id = "opper";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;

  constructor(opts: OpperProviderOptions = {}) {
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

  /** Pools come first, followed by the rest of the catalog the key can use. */
  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw missingCatalogCredentials("Opper");

    try {
      const [pools, catalog] = await Promise.all([
        // Pools only reorder the picker; the full catalog still lists every id.
        this.fetchModels("/models?type=pool", apiKey).catch(() => []),
        this.fetchModels("/models", apiKey),
      ]);
      const seen = new Set<string>();
      const discovered = [...pools, ...catalog].flatMap((model) => {
        if (!model.id || seen.has(model.id)) return [];
        if (model.opper?.type && model.opper.type !== "llm") return [];
        seen.add(model.id);
        const contextWindow = positiveInteger(model.context_length);
        const maxOutputTokens = positiveInteger(model.opper?.max_output_tokens);
        const capabilities = model.opper?.capabilities;
        const label = model.opper?.kind === "pool" ? "Opper pool" : "Opper";
        return [{
          id: model.id,
          provider: "opper",
          displayName: `${model.id} (${label})`,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(capabilities
            ? {
                supportsTools: capabilities.includes("tools"),
                supportsVision: capabilities.includes("vision"),
              }
            : {}),
        }];
      });
      const descriptors = await enrichModelDescriptors(
        discovered,
        "opper",
        this.modelsDev,
      );
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("Opper", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new OpperBuildError(
        "No Opper API key configured (set OPPER_API_KEY).",
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

  private async fetchModels(path: string, apiKey: string): Promise<OpperModel[]> {
    const response = await this.fetchFn(`${this.resolveBaseUrl()}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw catalogHttpError("Opper", response.status);
    const body = (await response.json()) as OpperModelsResponse;
    return body.data ?? [];
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey || process.env.OPPER_API_KEY || undefined;
  }

  private resolveBaseUrl(): string {
    const baseUrl = this.baseUrl || process.env.OPPER_BASE_URL || DEFAULT_BASE_URL;
    return baseUrl.replace(/\/$/, "");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
