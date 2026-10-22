/** LiteLLM proxy provider backed by the OpenAI-compatible Chat Completions model. */
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
} from "../catalog-error.js";
import { createOpenAiChatModel } from "./openai.js";

const DEFAULT_BASE_URL = "http://localhost:4000/v1";
const DEFAULT_MAX_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;
// ChatOpenAI falls back to OPENAI_API_KEY when no key is given, which would
// send a real OpenAI key to the proxy. A keyless proxy gets this placeholder,
// and keylessFetch strips the header so no credential is sent at all.
const KEYLESS_PLACEHOLDER = "litellm-no-key";

/** One entry of the proxy's `/model/info` response. */
interface LiteLLMModelInfo {
  model_name?: string;
  model_info?: {
    mode?: string | null;
    max_input_tokens?: number | null;
    max_output_tokens?: number | null;
    max_tokens?: number | null;
    supports_function_calling?: boolean | null;
    supports_vision?: boolean | null;
  } | null;
}

interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfo[];
}

interface OpenAiModelsResponse {
  data?: { id?: string }[];
}

export interface LiteLLMProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "Proxy URL and key",
    fields: [
      {
        key: "baseUrl",
        label: "LiteLLM proxy URL",
        type: "text",
        required: false,
        default: DEFAULT_BASE_URL,
      },
      {
        key: "apiKey",
        label: "Master or virtual key (blank if the proxy has no master key)",
        type: "password",
        required: false,
      },
      {
        key: "maxTokens",
        label: "Output token budget",
        type: "text",
        required: false,
        default: String(DEFAULT_MAX_TOKENS),
      },
    ],
  },
];

export class LiteLLMLangChainModelProvider implements ModelProvider {
  readonly id = "litellm";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;

  constructor(opts: LiteLLMProviderOptions = {}) {
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
    this.apiKey = cfg.values.apiKey?.trim() || undefined;
    this.maxTokens = positiveInteger(cfg.values.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = cfg.values.baseUrl?.trim() || undefined;
    if (!this.models) this.descriptors.clear();
  }

  /**
   * Chat models the proxy serves, with the limits and capabilities LiteLLM
   * reports in `/model/info`. Falls back to `/models` (ids only) for proxies
   * that do not expose model info.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    let descriptors: ModelDescriptor[];
    try {
      descriptors = await this.fetchModelInfo();
    } catch (infoError) {
      if (isAuthError(infoError)) throw infoError;
      try {
        descriptors = await this.fetchModelIds();
      } catch (cause) {
        if (isAuthError(cause)) throw cause;
        throw catalogConnectionError("LiteLLM", cause);
      }
    }
    this.descriptors.clear();
    for (const descriptor of descriptors) {
      this.descriptors.set(descriptor.id, descriptor);
    }
    return descriptors;
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    const configuredMax = Math.min(
      this.maxTokens,
      descriptor?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    );
    const apiKey = this.resolveApiKey();
    return createOpenAiChatModel({
      modelId,
      apiKey: apiKey ?? KEYLESS_PLACEHOLDER,
      maxTokens: Math.min(
        configuredMax,
        this.learnedMaxTokens.get(modelId) ?? Number.POSITIVE_INFINITY,
      ),
      apiMode: "chat-completions",
      baseUrl: this.resolveBaseUrl(),
      fetch: apiKey ? this.fetchFn : keylessFetch(this.fetchFn),
      learnedMaxTokens: this.learnedMaxTokens,
      ...(descriptor ? { descriptor } : {}),
    });
  }

  private async fetchModelInfo(): Promise<ModelDescriptor[]> {
    const body = await this.getJson<LiteLLMModelInfoResponse>("/model/info");
    const seen = new Set<string>();
    return (body.data ?? []).flatMap((entry) => {
      const id = entry.model_name;
      const info = entry.model_info ?? {};
      // Skip embedding, image, audio and rerank deployments; only chat models can drive the agent.
      if (!id || seen.has(id) || (info.mode && info.mode !== "chat")) return [];
      seen.add(id);
      const contextWindow = positiveInteger(info.max_input_tokens);
      const maxOutputTokens = positiveInteger(info.max_output_tokens ?? info.max_tokens);
      return [{
        id,
        provider: "litellm",
        displayName: `${id} (LiteLLM)`,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(typeof info.supports_function_calling === "boolean"
          ? { supportsTools: info.supports_function_calling }
          : {}),
        ...(typeof info.supports_vision === "boolean"
          ? { supportsVision: info.supports_vision }
          : {}),
      }];
    });
  }

  private async fetchModelIds(): Promise<ModelDescriptor[]> {
    const body = await this.getJson<OpenAiModelsResponse>("/models");
    return (body.data ?? []).flatMap((model) =>
      model.id
        ? [{ id: model.id, provider: "litellm", displayName: `${model.id} (LiteLLM)` }]
        : [],
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    const apiKey = this.resolveApiKey();
    const response = await this.fetchFn(`${this.resolveBaseUrl()}${path}`, {
      ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw catalogHttpError("LiteLLM", response.status);
    return (await response.json()) as T;
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey || process.env.LITELLM_API_KEY || undefined;
  }

  private resolveBaseUrl(): string {
    const baseUrl = this.baseUrl || process.env.LITELLM_BASE_URL || DEFAULT_BASE_URL;
    return baseUrl.replace(/\/$/, "");
  }
}

/** Drops the placeholder Authorization header for proxies without a master key. */
function keylessFetch(fetchFn: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return fetchFn(input, { ...init, headers });
  };
}

function isAuthError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "authentication"
  );
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
