/** UberLLM gateway: the listing also carries image/video/audio models and marks offline ones `available: false`. */
import {
  OpenAiCompatibleProvider,
  readCommonModelFields,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
} from "./openai-compatible.js";

export const UBERLLM_SPEC: OpenAiCompatibleSpec = {
  id: "uberllm",
  label: "UberLLM",
  defaultBaseUrl: "https://api.uberllm.dev/v1",
  envPrefix: "UBERLLM",
  readModel(entry) {
    if ((entry.type && entry.type !== "chat") || entry.available === false) return undefined;
    return readCommonModelFields(entry);
  },
};

export class UberLlmLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(UBERLLM_SPEC, opts);
  }
}
