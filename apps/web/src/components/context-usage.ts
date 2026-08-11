export interface ContextUsageDisplay {
  used: number;
  windowSize?: number;
}

/**
 * Usage is useful even when a provider cannot report the model's maximum
 * context window. No response usage means there is no reliable count to show.
 */
export function contextUsageDisplay(
  usage: { input: number; output: number } | undefined,
  contextWindow: number | undefined,
): ContextUsageDisplay | undefined {
  if (!usage) return undefined;

  const used = usage.input + usage.output;
  return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
    ? { used, windowSize: contextWindow }
    : { used };
}
