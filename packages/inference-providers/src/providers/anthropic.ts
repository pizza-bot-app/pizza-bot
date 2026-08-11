/** Anthropic-direct provider backed by lazy-loaded `ChatAnthropic`. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const FETCH_TIMEOUT_MS = 5_000;

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
    fields: [{ key: "apiKey", label: "API key", type: "password", required: true }],
  },
];

export class AnthropicLangChainModelProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly authSchema = AUTH_SCHEMA;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.models = opts.models;
    this.maxTokens = resolveMaxTokens(opts.maxTokens);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    this.apiKey = opts.apiKey;
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    const key = cfg.values.apiKey?.trim();
    if (key) this.apiKey = key;
    if (!this.models) this.descriptors.clear();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw missingCatalogCredentials("Anthropic");

    try {
      const response = await this.fetchFn(`${this.baseUrl}/v1/models?limit=1000`, {
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
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
      const descriptors = await enrichModelDescriptors(discovered, "anthropic", this.modelsDev);
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("Anthropic", cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    try {
      return await this.construct(modelId);
    } catch (err) {
      const code = translateAnthropicError(err);
      if (code)
        throw new AnthropicBuildError(err instanceof Error ? err.message : String(err), code, { cause: err });
      throw err;
    }
  }

  private async construct(modelId: string): Promise<BaseChatModel> {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    const apiKey = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AnthropicBuildError("No Anthropic API key configured (set ANTHROPIC_API_KEY).", "AUTH_EXPIRED");
    }
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);

    class ContextAwareChatAnthropic extends ChatAnthropic {
      override get profile() {
        return withContextWindow(super.profile, descriptor?.contextWindow);
      }
    }

    return new ContextAwareChatAnthropic({
      model: modelId,
      apiKey,
      maxTokens: this.maxTokens,
    });
  }
}
