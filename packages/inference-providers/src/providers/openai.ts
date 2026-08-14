/** OpenAI provider backed by lazy-loaded `ChatOpenAI`. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { ChatOpenAIFields } from "@langchain/openai";
import type { ModelProvider, ModelDescriptor, ResolvedProviderConfig, ProviderAuthMethod } from "@pizza-bot/core";
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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TOKENS = 8_192;

export type OpenAiApiMode = "auto" | "responses" | "chat-completions";

interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

/** Translate OpenAI status and message fields to the recovery taxonomy. */
export function translateOpenAIError(err: unknown): "AUTH_EXPIRED" | "RATE_LIMIT" | undefined {
  const status = statusOf(err);
  if (status === 401 || status === 403) return "AUTH_EXPIRED";
  if (status === 429) return "RATE_LIMIT";
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.name, err.message);
  else if (typeof err === "string") parts.push(err);
  const m = parts.join(" ").toLowerCase();
  if (
    m.includes("incorrect api key") ||
    m.includes("invalid api key") ||
    m.includes("authentication") ||
    m.includes("unauthorized")
  ) {
    return "AUTH_EXPIRED";
  }
  if (m.includes("rate limit") || m.includes("too many requests")) return "RATE_LIMIT";
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export interface OpenAiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
  catalogProvider?: string;
  maxTokens?: number;
  apiMode?: OpenAiApiMode;
}

class OpenAiBuildError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH_EXPIRED" | "RATE_LIMIT",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OpenAiBuildError";
  }
}

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "api-key",
    label: "API key",
    fields: [
      { key: "apiKey", label: "API key", type: "password", required: true },
      { key: "baseUrl", label: "Base URL", type: "text", required: false },
      {
        key: "apiMode",
        label: "API",
        type: "select",
        required: false,
        default: "auto",
        options: [
          { value: "auto", label: "Automatic" },
          { value: "responses", label: "Responses" },
          { value: "chat-completions", label: "Chat Completions" },
        ],
      },
      {
        key: "maxTokens",
        label: "Output token budget",
        type: "text",
        required: false,
        default: String(DEFAULT_MAX_TOKENS),
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

export class OpenAiLangChainModelProvider implements ModelProvider {
  readonly id = "openai";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;
  private catalogProvider: string | undefined;
  private apiMode: OpenAiApiMode;

  constructor(opts: OpenAiProviderOptions = {}) {
    this.models = opts.models;
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.maxTokens = positiveInteger(opts.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.catalogProvider = opts.catalogProvider;
    this.apiMode = opts.apiMode ?? "auto";
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    const key = cfg.values.apiKey?.trim();
    if (key) this.apiKey = key;
    this.baseUrl = cfg.values.baseUrl?.trim() || undefined;
    this.maxTokens = positiveInteger(cfg.values.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.catalogProvider = cfg.values.catalogProvider?.trim() || undefined;
    this.apiMode = parseApiMode(cfg.values.apiMode);
    if (!this.models) this.descriptors.clear();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw missingCatalogCredentials("OpenAI");
    const baseUrl =
      (this.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    try {
      const response = await this.fetchFn(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw catalogHttpError("OpenAI", response.status);
      const body = (await response.json()) as OpenAiModelsResponse;
      const discovered: ModelDescriptor[] = (body.data ?? []).flatMap((model) => {
        if (!model.id || !isChatModel(model.id)) return [];
        return [{
          id: model.id,
          provider: "openai",
          displayName: `${model.id} (OpenAI)`,
        }];
      });
      const catalogProvider = this.catalogProvider ?? inferCatalogProvider(baseUrl);
      const enriched = catalogProvider
        ? await enrichModelDescriptors(discovered, catalogProvider, this.modelsDev)
        : discovered;
      const descriptors = enriched.map((descriptor) => ({
        ...descriptor,
        supportsTools: descriptor.supportsTools ?? true,
        supportsVision: descriptor.supportsVision ?? true,
      }));
      this.descriptors.clear();
      for (const descriptor of descriptors) this.descriptors.set(descriptor.id, descriptor);
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("OpenAI", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    try {
      return await this.construct(modelId);
    } catch (err) {
      const code = translateOpenAIError(err);
      if (code)
        throw new OpenAiBuildError(err instanceof Error ? err.message : String(err), code, { cause: err });
      throw err;
    }
  }

  private async construct(modelId: string): Promise<BaseChatModel> {
    const apiKey = this.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new OpenAiBuildError("No OpenAI API key configured (set OPENAI_API_KEY).", "AUTH_EXPIRED");
    }
    const configuredBaseUrl = this.baseUrl ?? process.env.OPENAI_BASE_URL;
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    const configuredMax = Math.min(
      this.maxTokens,
      descriptor?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    );
    const learnedMaxTokens = this.learnedMaxTokens;
    const initialMax = Math.min(
      configuredMax,
      learnedMaxTokens.get(modelId) ?? Number.POSITIVE_INFINITY,
    );
    return createOpenAiChatModel({
      modelId,
      apiKey,
      maxTokens: initialMax,
      apiMode: this.apiMode,
      learnedMaxTokens,
      fetch: this.fetchFn,
      ...(descriptor ? { descriptor } : {}),
      ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
    });
  }
}

export interface OpenAiChatModelOptions {
  modelId: string;
  apiKey: string;
  maxTokens: number;
  apiMode: OpenAiApiMode;
  descriptor?: ModelDescriptor;
  learnedMaxTokens?: Map<string, number>;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export async function createOpenAiChatModel(
  options: OpenAiChatModelOptions,
): Promise<BaseChatModel> {
  const { ChatOpenAI } = await import("@langchain/openai");
  const {
    modelId,
    apiKey,
    maxTokens,
    apiMode,
    descriptor,
    learnedMaxTokens,
    baseUrl,
    fetch: fetchFn,
  } = options;
  const fields = {
    model: modelId,
    apiKey,
    maxTokens,
    useResponsesApi: apiMode === "responses",
    ...((baseUrl || fetchFn)
      ? {
          configuration: {
            ...(baseUrl ? { baseURL: baseUrl } : {}),
            ...(fetchFn ? { fetch: fetchFn } : {}),
          },
        }
      : {}),
  };

  class DialectChatOpenAI extends ChatOpenAI {
    override get profile() {
      return withContextWindow(super.profile, descriptor?.contextWindow);
    }

    protected override _useResponsesApi(
      callOptions: this["ParsedCallOptions"] | undefined,
    ): boolean {
      if (apiMode === "responses") return true;
      if (apiMode === "chat-completions") return false;
      return super._useResponsesApi(callOptions);
    }

    override withConfig(config: Partial<this["ParsedCallOptions"]>) {
      const model = this.clone(this.fields);
      model.defaultOptions = {
        ...this.defaultOptions,
        ...config,
      };
      return model;
    }

    protected clone(fields?: ChatOpenAIFields): DialectChatOpenAI {
      return new DialectChatOpenAI(fields);
    }
  }

  class AdaptiveChatOpenAI extends DialectChatOpenAI {
    protected override clone(fields?: ChatOpenAIFields): AdaptiveChatOpenAI {
      return new AdaptiveChatOpenAI(fields);
    }

    override async _generate(
      messages: BaseMessage[],
      callOptions: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ): Promise<ChatResult> {
      try {
        return await super._generate(messages, callOptions, runManager);
      } catch (error) {
        const retry = retryModel(error);
        if (!retry) throw error;
        return retry._generate(messages, callOptions, runManager);
      }
    }

    override async *_streamResponseChunks(
      messages: BaseMessage[],
      callOptions: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatGenerationChunk> {
      let emitted = false;
      try {
        for await (const chunk of super._streamResponseChunks(
          messages,
          callOptions,
          runManager,
        )) {
          emitted = true;
          yield chunk;
        }
      } catch (error) {
        const retry = emitted ? undefined : retryModel(error);
        if (!retry) throw error;
        yield* retry._streamResponseChunks(messages, callOptions, runManager);
      }
    }

    override async *_streamChatModelEvents(
      messages: BaseMessage[],
      callOptions: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatModelStreamEvent> {
      let emitted = false;
      try {
        for await (const event of super._streamChatModelEvents(
          messages,
          callOptions,
          runManager,
        )) {
          emitted = true;
          yield event;
        }
      } catch (error) {
        const retry = emitted ? undefined : retryModel(error);
        if (!retry) throw error;
        yield* retry._streamChatModelEvents(messages, callOptions, runManager);
      }
    }
  }

  const retryModel = (error: unknown) => {
    const retryCap = retryOutputCap(error, maxTokens);
    if (retryCap === undefined) return undefined;
    learnedMaxTokens?.set(modelId, retryCap);
    return new DialectChatOpenAI({ ...fields, maxTokens: retryCap });
  };

  return new AdaptiveChatOpenAI(fields);
}

/** The models API includes embeddings, image, audio, and moderation models. */
export function isChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return ![
    "embedding",
    "dall-e",
    "whisper",
    "moderation",
    "realtime",
    "gpt-image",
    "chatgpt-image",
    "tts-",
    "sora",
  ].some((nonChat) => id.includes(nonChat));
}

function inferCatalogProvider(baseUrl: string): string | undefined {
  const hostname = new URL(baseUrl).hostname;
  if (hostname === "api.openai.com") return "openai";
  if (hostname === "ai-gateway.vercel.sh") return "vercel";
  return undefined;
}

function positiveInteger(value: number | string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseApiMode(value: string | undefined): OpenAiApiMode {
  return value === "responses" || value === "chat-completions" ? value : "auto";
}

export function retryOutputCap(error: unknown, current: number): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/max_tokens/i.test(message)) return undefined;
  const total = /max_total_tokens[^0-9]{0,20}(\d+)/i.exec(message)?.[1];
  if (!total) return undefined;
  const safe = Number(total);
  if (!Number.isSafeInteger(safe) || safe <= 0 || safe >= current) return undefined;
  const next = Math.min(DEFAULT_MAX_TOKENS, safe);
  return Number.isSafeInteger(next) && next > 0 && next < current ? next : undefined;
}
