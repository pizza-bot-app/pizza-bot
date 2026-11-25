/** Opper gateway: pools are listed first, and capabilities live under `opper`. */
import {
  OpenAiCompatibleProvider,
  positiveInteger,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
  type RawModelEntry,
} from "./openai-compatible.js";

interface OpperExtension {
  kind?: string;
  type?: string;
  capabilities?: string[];
  max_output_tokens?: number;
}

export const OPPER_SPEC: OpenAiCompatibleSpec = {
  id: "opper",
  label: "Opper",
  defaultBaseUrl: "https://api.opper.ai/v3/compat",
  envPrefix: "OPPER",
  catalogProvider: "opper",
  featuredModelsPath: "/models?type=pool",
  readModel(entry: RawModelEntry) {
    const opper = (entry.opper ?? {}) as OpperExtension;
    if (typeof entry.id !== "string" || !entry.id) return undefined;
    if (opper.type && opper.type !== "llm") return undefined;
    const capabilities = opper.capabilities;
    return {
      id: entry.id,
      label: opper.kind === "pool" ? "Opper pool" : "Opper",
      contextWindow: positiveInteger(entry.context_length),
      maxOutputTokens: positiveInteger(opper.max_output_tokens),
      ...(capabilities
        ? {
            supportsTools: capabilities.includes("tools"),
            supportsVision: capabilities.includes("vision"),
          }
        : {}),
    };
  },
};

export class OpperLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(OPPER_SPEC, opts);
  }
}
