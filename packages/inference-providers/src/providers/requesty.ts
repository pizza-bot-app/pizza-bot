/** Requesty gateway: managed policies are listed first; only `api: "chat"` rows can drive the agent. */
import {
  OpenAiCompatibleProvider,
  readCommonModelFields,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleSpec,
} from "./openai-compatible.js";

export const REQUESTY_SPEC: OpenAiCompatibleSpec = {
  id: "requesty",
  label: "Requesty",
  defaultBaseUrl: "https://router.requesty.ai/v1",
  envPrefix: "REQUESTY",
  catalogProvider: "requesty",
  featuredModelsPath: "/models/managed",
  readModel(entry, featured) {
    if (entry.api && entry.api !== "chat") return undefined;
    const facts = readCommonModelFields(entry);
    return facts && featured ? { ...facts, label: "Requesty managed" } : facts;
  },
};

export class RequestyLangChainModelProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiCompatibleProviderOptions = {}) {
    super(REQUESTY_SPEC, opts);
  }
}
