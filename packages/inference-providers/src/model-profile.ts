import type { ModelProfile } from "@langchain/core/language_models/profile";

export function withContextWindow(
  profile: ModelProfile | undefined,
  contextWindow: number | undefined,
): ModelProfile {
  const base = profile ?? {};
  return contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? { ...base, maxInputTokens: contextWindow }
    : base;
}
