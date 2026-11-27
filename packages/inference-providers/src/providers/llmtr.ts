/** LLMTR gateway: OpenAI-shaped listing; OpenRouter-style architecture / supported_parameters are used when present. */
import {
  OpenAiCompatibleProvider,
  readCommonModelFields,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
} from "./openai-compatible.js";

export const LLMTR_SPEC: OpenAiCompatibleSpec = {
  id: "llmtr",
  label: "LLMTR",
  defaultBaseUrl: "https://llmtr.com/v1",
  envPrefix: "LLMTR",
  readModel(entry) {
    const facts = readCommonModelFields(entry);
    if (!facts) return undefined;
    const architecture = (entry.architecture ?? {}) as { input_modalities?: unknown };
    const supportedParameters = Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters
      : undefined;
    const inputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : undefined;
    return {
      ...facts,
      supportsTools: facts.supportsTools ?? (supportedParameters ? supportedParameters.includes("tools") : undefined),
      supportsVision: facts.supportsVision ?? (inputModalities ? inputModalities.includes("image") : undefined),
    };
  },
};

export class LlmtrLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(LLMTR_SPEC, opts);
  }
}
