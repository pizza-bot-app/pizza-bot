/** TrustedRouter gateway: skips internal/hidden/synthetic and non-chat entries; limits and capabilities live under `top_provider`, `supported_parameters`, and `architecture`. */
import {
  OpenAiCompatibleProvider,
  positiveInteger,
  readCommonModelFields,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
  type RawModelEntry,
} from "./openai-compatible.js";

interface TrustedRouterExtension {
  internal_only?: boolean;
  configuration_hidden?: boolean;
  synthetic_monitor?: boolean;
  supports_chat?: boolean;
}

interface TrustedRouterTopProvider {
  context_length?: number;
  max_completion_tokens?: number | null;
}

interface TrustedRouterArchitecture {
  input_modalities?: unknown;
}

export const TRUSTEDROUTER_SPEC: OpenAiCompatibleSpec = {
  id: "trustedrouter",
  label: "TrustedRouter",
  defaultBaseUrl: "https://api.trustedrouter.com/v1",
  envPrefix: "TRUSTEDROUTER",
  readModel(entry: RawModelEntry) {
    const tr = (entry.trustedrouter ?? {}) as TrustedRouterExtension;
    if (
      tr.internal_only === true ||
      entry.internal_only === true ||
      tr.configuration_hidden === true ||
      entry.configuration_hidden === true ||
      tr.synthetic_monitor === true ||
      entry.synthetic_monitor === true ||
      tr.supports_chat === false
    ) {
      return undefined;
    }
    const facts = readCommonModelFields(entry);
    if (!facts) return undefined;
    const topProvider = (entry.top_provider ?? {}) as TrustedRouterTopProvider;
    const architecture = (entry.architecture ?? {}) as TrustedRouterArchitecture;
    const supportedParameters = Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters
      : undefined;
    const inputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : undefined;
    return {
      ...facts,
      contextWindow: facts.contextWindow ?? positiveInteger(topProvider.context_length),
      maxOutputTokens: facts.maxOutputTokens ?? positiveInteger(topProvider.max_completion_tokens),
      supportsTools: facts.supportsTools ?? (supportedParameters ? supportedParameters.includes("tools") : undefined),
      supportsVision: facts.supportsVision ?? (inputModalities ? inputModalities.includes("image") : undefined),
    };
  },
};

export class TrustedRouterLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(TRUSTEDROUTER_SPEC, opts);
  }
}
