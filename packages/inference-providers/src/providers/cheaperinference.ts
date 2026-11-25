/** Cheaper Inference gateway: only `type: "text"` rows can drive the agent; vision lives under `capabilities`. */
import {
  OpenAiCompatibleProvider,
  readCommonModelFields,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
} from "./openai-compatible.js";

export const CHEAPER_INFERENCE_SPEC: OpenAiCompatibleSpec = {
  id: "cheaperinference",
  label: "Cheaper Inference",
  defaultBaseUrl: "https://api.cheaperinference.com/v1",
  envPrefix: "CHEAPER_INFERENCE",
  readModel(entry) {
    if (entry.type && entry.type !== "text") return undefined;
    const facts = readCommonModelFields(entry);
    const vision = (entry.capabilities as { vision?: unknown } | undefined)?.vision;
    return facts && typeof vision === "boolean" ? { ...facts, supportsVision: vision } : facts;
  },
};

export class CheaperInferenceLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(CHEAPER_INFERENCE_SPEC, opts);
  }
}
