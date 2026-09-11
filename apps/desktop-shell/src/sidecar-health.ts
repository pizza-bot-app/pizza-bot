/**
 * Decides when a failing sidecar health probe justifies killing the child, and
 * when a child has been healthy long enough to earn a fresh restart budget.
 */

/** `unreachable` is a probe that never answered; `unhealthy` is a refusal. */
export type ProbeOutcome = "healthy" | "warming" | "unhealthy" | "unreachable";

export interface HealthPolicyLimits {
  /** Consecutive failing probes tolerated before the child is killed. */
  failureThreshold: number;
  /**
   * Unanswered probes are tolerated for this long after a spawn. A sidecar
   * connecting many stdio MCP servers stalls its event loop for seconds at a
   * time, and killing it there means startup can never finish.
   */
  startupGraceMs: number;
  /** Uninterrupted healthy time that clears the restart budget. */
  stabilityMs: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicyLimits = {
  failureThreshold: 3,
  startupGraceMs: 120_000,
  stabilityMs: 60_000,
};

export interface HealthState {
  /** Handshake time of the current child, not of the supervisor. */
  spawnedAt: number;
  consecutiveFailures: number;
  healthySince: number | undefined;
}

export interface HealthDecision {
  state: HealthState;
  kill: boolean;
  clearRestartBudget: boolean;
}

export function initialHealthState(spawnedAt: number): HealthState {
  return { spawnedAt, consecutiveFailures: 0, healthySince: undefined };
}

export function applyProbe(
  state: HealthState,
  outcome: ProbeOutcome,
  now: number,
  limits: HealthPolicyLimits = DEFAULT_HEALTH_POLICY,
): HealthDecision {
  if (outcome === "healthy") {
    const healthySince = state.healthySince ?? now;
    return {
      state: { ...state, consecutiveFailures: 0, healthySince },
      kill: false,
      clearRestartBudget: now - healthySince >= limits.stabilityMs,
    };
  }

  // A warming sidecar answered, so it is not wedged; restarting only replays the
  // same startup work. Waiting is the sole way for a slow warm-up to complete.
  if (outcome === "warming") {
    return {
      state: { ...state, consecutiveFailures: 0, healthySince: undefined },
      kill: false,
      clearRestartBudget: false,
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const withinGrace =
    outcome === "unreachable" && now - state.spawnedAt < limits.startupGraceMs;
  const kill = !withinGrace && consecutiveFailures >= limits.failureThreshold;
  return {
    // The counter's job ends at the kill; the replacement child starts clean.
    state: {
      ...state,
      consecutiveFailures: kill ? 0 : consecutiveFailures,
      healthySince: undefined,
    },
    kill,
    clearRestartBudget: false,
  };
}
