/** Shared adapter for hosted OpenAI-compatible gateways; each gateway is a spec. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ModelDescriptor,
  ModelProvider,
  ProviderAuthField,
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
import {
  parseRequestOverrides,
  REQUEST_OVERRIDES_FIELD,
  type RequestOverrides,
} from "../request-overrides.js";
import { createOpenAiChatModel } from "./openai.js";

const DEFAULT_MAX_TOKENS = 8_192;
const FETCH_TIMEOUT_MS = 5_000;
// ChatOpenAI falls back to OPENAI_API_KEY when given no key, which would send a
// real OpenAI key to the gateway; keyless specs pass this and strip the header.
const KEYLESS_PLACEHOLDER = "keyless";

export type RawModelEntry = Record<string, unknown>;

export interface CompatibleModelFacts {
  id: string;
  /** Suffix shown in the picker; defaults to the gateway's label. */
  label?: string;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  supportsTools?: boolean | undefined;
  supportsVision?: boolean | undefined;
}

export interface OpenAiCompatibleSpec {
  id: string;
  label: string;
  defaultBaseUrl: string;
  /** `OPPER` reads `OPPER_API_KEY` and `OPPER_BASE_URL`. */
  envPrefix: string;
  /** models.dev provider id used to fill gaps in the gateway's own listing. */
  catalogProvider?: string;
  /** A second listing whose models are shown first; if it fails only the ordering is lost. */
  featuredModelsPath?: string;
  /** Returns undefined to leave an entry (embeddings, images, offline models) out of the picker. */
  readModel?(entry: RawModelEntry, featured: boolean): CompatibleModelFacts | undefined;
  /**
   * Replaces the `/models` (and featured) listing. `fetchListing` GETs a path
   * under the base URL and returns its `data` array; a thrown catalog error is surfaced as is.
   */
  discoverModels?(
    fetchListing: (path: string) => Promise<RawModelEntry[]>,
  ): Promise<CompatibleModelFacts[]>;
  /** With no key, requests go out without an `Authorization` header. */
  keyOptional?: boolean;
}

export interface OpenAiCompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  models?: ModelDescriptor[];
  fetch?: typeof fetch;
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
}

class OpenAiCompatibleBuildError extends Error {
  constructor(message: string, readonly code: "AUTH_EXPIRED") {
    super(message);
    this.name = "OpenAiCompatibleBuildError";
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly authSchema: readonly ProviderAuthMethod[];
  private readonly models: ModelDescriptor[] | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly learnedMaxTokens = new Map<string, number>();
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private apiKey: string | undefined;
  private baseUrl: string | undefined;
  private maxTokens: number;
  private requestOverrides: RequestOverrides | undefined;
  private configured: boolean;

  constructor(private readonly spec: OpenAiCompatibleSpec, opts: OpenAiCompatibleProviderOptions = {}) {
    this.id = spec.id;
    const apiKeyField: ProviderAuthField = {
      key: "apiKey",
      label: `${spec.label} API key`,
      type: "password",
      required: !spec.keyOptional,
    };
    const maxTokensField: ProviderAuthField = {
      key: "maxTokens",
      label: "Output token budget",
      type: "text",
      required: false,
      default: String(DEFAULT_MAX_TOKENS),
    };
    const baseUrlField: ProviderAuthField = {
      key: "baseUrl",
      label: "Base URL",
      type: "text",
      required: false,
      default: spec.defaultBaseUrl,
    };
    this.authSchema = [{
      id: "api-key",
      label: "API key",
      fields: [apiKeyField, maxTokensField, baseUrlField, REQUEST_OVERRIDES_FIELD],
    }];
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.configured = opts.apiKey !== undefined || opts.baseUrl !== undefined;
    this.maxTokens = positiveInteger(opts.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.models = opts.models;
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
  }

  configure(cfg: ResolvedProviderConfig): void {
    // Parse before mutating so a rejected save leaves the live provider untouched.
    const requestOverrides = parseRequestOverrides(cfg.values.requestOverrides);
    const key = cfg.values.apiKey?.trim();
    // A blank key on a keyless-capable gateway means "go keyless", not "keep the old key".
    if (key || this.spec.keyOptional) this.apiKey = key || undefined;
    this.maxTokens = positiveInteger(cfg.values.maxTokens) ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = cfg.values.baseUrl?.trim() || undefined;
    this.requestOverrides = requestOverrides;
    this.configured = true;
    if (!this.models) this.descriptors.clear();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    const { label } = this.spec;
    const apiKey = this.resolveApiKey();
    if (!apiKey && !this.spec.keyOptional) throw missingCatalogCredentials(label);
    // A keyless default URL (often localhost) is only probed once the user has set the provider up;
    // otherwise every catalog load would wait on a port that may accept and never answer.
    if (!apiKey && !this.configured && !process.env[`${this.spec.envPrefix}_BASE_URL`]) {
      throw missingCatalogCredentials(label);
    }

    try {
      const fetchListing = (path: string) => this.fetchModels(path, apiKey);
      const listed: (CompatibleModelFacts | undefined)[] = this.spec.discoverModels
        ? await this.spec.discoverModels(fetchListing)
        : await this.discoverFromModels(fetchListing);
      const seen = new Set<string>();
      const discovered = listed.flatMap((facts): ModelDescriptor[] => {
        if (!facts || seen.has(facts.id)) return [];
        seen.add(facts.id);
        const { id, label: modelLabel, ...limits } = facts;
        return [{
          id,
          provider: this.id,
          displayName: `${id} (${modelLabel ?? label})`,
          ...definedOnly(limits),
        }];
      });
      const descriptors = this.spec.catalogProvider
        ? await enrichModelDescriptors(discovered, this.spec.catalogProvider, this.modelsDev)
        : discovered;
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError(label, cause);
    }
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const apiKey = this.resolveApiKey();
    if (!apiKey && !this.spec.keyOptional) {
      throw new OpenAiCompatibleBuildError(
        `No ${this.spec.label} API key configured (set ${this.spec.envPrefix}_API_KEY).`,
        "AUTH_EXPIRED",
      );
    }
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    return createOpenAiChatModel({
      modelId,
      apiKey: apiKey ?? KEYLESS_PLACEHOLDER,
      maxTokens: Math.min(
        this.maxTokens,
        descriptor?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
        this.learnedMaxTokens.get(modelId) ?? Number.POSITIVE_INFINITY,
      ),
      apiMode: "chat-completions",
      baseUrl: this.resolveBaseUrl(),
      fetch: apiKey ? this.fetchFn : withoutAuthorization(this.fetchFn),
      learnedMaxTokens: this.learnedMaxTokens,
      ...(descriptor ? { descriptor } : {}),
      ...(this.requestOverrides ? { requestOverrides: this.requestOverrides } : {}),
    });
  }

  private async discoverFromModels(
    fetchListing: (path: string) => Promise<RawModelEntry[]>,
  ): Promise<(CompatibleModelFacts | undefined)[]> {
    const featuredPath = this.spec.featuredModelsPath;
    const [featured, catalog] = await Promise.all([
      featuredPath ? fetchListing(featuredPath).catch(() => []) : [],
      fetchListing("/models"),
    ]);
    const readModel = this.spec.readModel ?? readCommonModelFields;
    return [
      ...featured.map((entry) => readModel(entry, true)),
      ...catalog.map((entry) => readModel(entry, false)),
    ];
  }

  private async fetchModels(path: string, apiKey: string | undefined): Promise<RawModelEntry[]> {
    const response = await this.fetchFn(`${this.resolveBaseUrl()}${path}`, {
      ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw catalogHttpError(this.spec.label, response.status);
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data)
      ? body.data.filter((entry): entry is RawModelEntry => !!entry && typeof entry === "object")
      : [];
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey || process.env[`${this.spec.envPrefix}_API_KEY`] || undefined;
  }

  private resolveBaseUrl(): string {
    const baseUrl = this.baseUrl
      || process.env[`${this.spec.envPrefix}_BASE_URL`]
      || this.spec.defaultBaseUrl;
    return baseUrl.replace(/\/$/, "");
  }
}

/** Reads the field names most OpenAI-compatible gateways add to `/models` entries. */
export function readCommonModelFields(entry: RawModelEntry): CompatibleModelFacts | undefined {
  if (typeof entry.id !== "string" || !entry.id) return undefined;
  return {
    id: entry.id,
    contextWindow: positiveInteger(entry.context_length ?? entry.context_window),
    maxOutputTokens: positiveInteger(entry.max_output_tokens),
    supportsTools: booleanOf(entry.supports_tools ?? entry.supports_tool_calling),
    supportsVision: booleanOf(entry.supports_vision),
  };
}

export function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function withoutAuthorization(fetchFn: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return fetchFn(input, { ...init, headers });
  };
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
