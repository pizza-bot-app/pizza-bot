/** Bedrock model configuration helpers. */
import type { ModelDescriptor } from "@pizza-bot/core";
import type { ModelsDevCatalogLoader } from "../../models-dev.js";

export function resolveRegion(explicit?: string): string {
  return explicit ?? process.env.AWS_REGION ?? "us-west-2";
}

/**
 * @langchain/aws defaults to 4096 output tokens, which adaptive thinking can
 * exhaust before producing visible content. Keep 8192 unless explicitly set.
 */
export function resolveMaxTokens(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const env = Number(process.env.PIZZA_MAX_TOKENS);
  return Number.isFinite(env) && env > 0 ? env : 8192;
}

/** Sonnet 5 and Opus accept adaptive reasoning; Haiku 4.5 rejects it. */
export function supportsReasoning(modelId: string): boolean {
  return /claude-(sonnet-5|opus-4-8|opus-5)/.test(modelId);
}

/**
 * Bedrock requires this shape for visible reasoning summaries; without it,
 * adaptive models return only an opaque signature block.
 */
export const REASONING_REQUEST_FIELDS = {
  reasoning_config: { type: "adaptive", display: "summarized" },
} as const;

export type BedrockToolChoiceValue = "auto" | "any" | "tool";

/**
 * @langchain/aws@1.4.2 recognizes only older Claude ids and rejects forced
 * `tool_choice` client-side. Bedrock accepts auto/any/tool for current Claude
 * families, so override those only. Remove when the SDK matcher covers these ids.
 */
export function supportedToolChoiceValues(modelId: string): BedrockToolChoiceValue[] | undefined {
  return modelId.includes("claude") ? ["auto", "any", "tool"] : undefined;
}

/** Translate AWS error fields to the provider-neutral recovery taxonomy. */
export function translateBedrockError(err: unknown): "AUTH_EXPIRED" | "RATE_LIMIT" | undefined {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.name, err.message);
  else if (typeof err === "string") parts.push(err);
  else if (err && typeof err === "object") {
    const o = err as { name?: unknown; message?: unknown; Code?: unknown; __type?: unknown };
    for (const v of [o.name, o.Code, o.__type, o.message]) if (typeof v === "string") parts.push(v);
  }
  const m = parts.join(" ").toLowerCase();
  if (
    m.includes("expiredtoken") ||
    m.includes("security token") ||
    m.includes("unrecognizedclient") ||
    m.includes("accessdenied") ||
    m.includes("credential") ||
    m.includes("could not load credentials")
  ) {
    return "AUTH_EXPIRED";
  }
  if (m.includes("throttl") || m.includes("too many requests")) return "RATE_LIMIT";
  return undefined;
}

export interface BedrockProviderOptions {
  region?: string;
  models?: ModelDescriptor[];
  maxTokens?: number;
  profile?: string;
  profiles?: readonly string[];
  client?: { send(command: unknown): Promise<unknown> };
  modelsDev?: ModelsDevCatalogLoader;
  modelsDevFetch?: typeof fetch;
}
