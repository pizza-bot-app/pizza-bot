import type { ModelDescriptor } from "@pizza-bot/core";

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;

export interface ModelsDevModel {
  id?: string;
  name?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  tool_call?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelsDevCatalog {
  [provider: string]: {
    models?: Record<string, ModelsDevModel>;
  };
}

export interface ModelsDevCatalogLoaderOptions {
  fetch?: typeof fetch;
  cacheTtlMs?: number;
  now?: () => number;
}

export class ModelsDevCatalogLoader {
  private readonly fetchFn: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { value: ModelsDevCatalog; expiresAt: number } | undefined;
  private inFlight: Promise<ModelsDevCatalog | undefined> | undefined;

  constructor(options: ModelsDevCatalogLoaderOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async models(provider: string): Promise<Record<string, ModelsDevModel> | undefined> {
    return (await this.catalog())?.[provider]?.models;
  }

  private async catalog(): Promise<ModelsDevCatalog | undefined> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.value;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.load();
    try {
      const value = await this.inFlight;
      if (value) {
        this.cached = {
          value,
          expiresAt: this.now() + this.cacheTtlMs,
        };
      }
      return value;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async load(): Promise<ModelsDevCatalog | undefined> {
    try {
      const response = await this.fetchFn(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return response.ok ? await response.json() as ModelsDevCatalog : undefined;
    } catch {
      return undefined;
    }
  }
}

export const defaultModelsDevCatalog = new ModelsDevCatalogLoader();

export function resolveModelsDevCatalog(
  loader: ModelsDevCatalogLoader | undefined,
  fetchFn: typeof fetch | undefined,
): ModelsDevCatalogLoader {
  return loader ?? (fetchFn ? new ModelsDevCatalogLoader({ fetch: fetchFn }) : defaultModelsDevCatalog);
}

export async function enrichModelDescriptors(
  descriptors: ModelDescriptor[],
  provider: string,
  loader: ModelsDevCatalogLoader,
): Promise<ModelDescriptor[]> {
  if (!descriptors.some(needsEnrichment)) return descriptors;
  const metadata = await loader.models(provider);
  if (!metadata) return descriptors;
  return descriptors.map((descriptor) => enrichModelDescriptor(descriptor, metadata[descriptor.id]));
}

export function enrichModelDescriptor(
  descriptor: ModelDescriptor,
  metadata: ModelsDevModel | undefined,
): ModelDescriptor {
  if (!metadata) return descriptor;
  const contextWindow = positiveInteger(metadata.limit?.context);
  const maxOutputTokens = positiveInteger(metadata.limit?.output);
  return {
    ...descriptor,
    ...(descriptor.contextWindow === undefined && contextWindow
      ? { contextWindow }
      : {}),
    ...(descriptor.maxOutputTokens === undefined && maxOutputTokens
      ? { maxOutputTokens }
      : {}),
    ...(descriptor.supportsTools === undefined && metadata.tool_call !== undefined
      ? { supportsTools: metadata.tool_call }
      : {}),
    ...(descriptor.supportsVision === undefined && metadata.modalities?.input
      ? { supportsVision: metadata.modalities.input.includes("image") }
      : {}),
  };
}

function needsEnrichment(descriptor: ModelDescriptor): boolean {
  return descriptor.contextWindow === undefined ||
    descriptor.maxOutputTokens === undefined ||
    descriptor.supportsTools === undefined ||
    descriptor.supportsVision === undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
