/** LiteLLM proxy: often keyless, and limits come from `/model/info` rather than `/models`. */
import { ModelCatalogError } from "@pizza-bot/core";
import {
  OpenAiCompatibleProvider,
  positiveInteger,
  type CompatibleModelFacts,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
  type RawModelEntry,
} from "./openai-compatible.js";

interface LiteLLMModelInfo {
  mode?: string | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  max_tokens?: number | null;
  supports_function_calling?: boolean | null;
  supports_vision?: boolean | null;
}

export const LITELLM_SPEC: OpenAiCompatibleSpec = {
  id: "litellm",
  label: "LiteLLM",
  defaultBaseUrl: "http://localhost:4000/v1",
  envPrefix: "LITELLM",
  keyOptional: true,
  async discoverModels(fetchListing) {
    try {
      return (await fetchListing("/model/info")).flatMap(readModelInfo);
    } catch (error) {
      // Only a missing or unparseable /model/info falls back; an unreachable proxy fails once.
      const missingEndpoint =
        (error instanceof ModelCatalogError && error.code === "endpoint") || error instanceof SyntaxError;
      if (!missingEndpoint) throw error;
      return (await fetchListing("/models")).flatMap((entry) =>
        isConcreteModel(entry.id) ? [{ id: entry.id }] : [],
      );
    }
  },
};

function readModelInfo(entry: RawModelEntry): CompatibleModelFacts[] {
  const id = entry.model_name;
  const info = (entry.model_info ?? {}) as LiteLLMModelInfo;
  // Embedding, image, audio and rerank deployments cannot drive the agent.
  if (!isConcreteModel(id) || (info.mode && info.mode !== "chat")) return [];
  return [{
    id,
    contextWindow: positiveInteger(info.max_input_tokens),
    maxOutputTokens: positiveInteger(info.max_output_tokens ?? info.max_tokens),
    supportsTools: info.supports_function_calling ?? undefined,
    supportsVision: info.supports_vision ?? undefined,
  }];
}

// Wildcard routes such as `openai/*` are listed by name but cannot be requested as a model.
function isConcreteModel(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !id.includes("*");
}

export class LiteLLMLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(LITELLM_SPEC, opts);
  }
}
