import { describe, expect, it } from "vitest";
import {
  applyProbe,
  DEFAULT_HEALTH_POLICY,
  initialHealthState,
  type HealthPolicyLimits,
  type ProbeOutcome,
} from "./sidecar-health.js";

const limits: HealthPolicyLimits = {
  failureThreshold: 3,
  startupGraceMs: 10_000,
  stabilityMs: 30_000,
};

/** Feeds a probe sequence from a fresh spawn, one probe per 5s tick. */
function run(
  outcomes: ProbeOutcome[],
  policy: HealthPolicyLimits = limits,
): { kills: number; clears: number; failures: number } {
  const spawnedAt = 1_000_000;
  let state = initialHealthState(spawnedAt);
  let kills = 0;
  let clears = 0;
  outcomes.forEach((outcome, i) => {
    const decision = applyProbe(state, outcome, spawnedAt + 5_000 * (i + 1), policy);
    state = decision.state;
    if (decision.kill) kills += 1;
    if (decision.clearRestartBudget) clears += 1;
  });
  return { kills, clears, failures: state.consecutiveFailures };
}

describe("applyProbe", () => {
  it("never kills a warming sidecar, however long it warms", () => {
    expect(run(Array<ProbeOutcome>(40).fill("warming")).kills).toBe(0);
  });

  it("tolerates unanswered probes inside the startup grace window", () => {
    // Two ticks land at +5s and +10s; only the second is past the 10s grace.
    expect(run(["unreachable", "unreachable"]).kills).toBe(0);
  });

  it("kills once unanswered probes reach the threshold past the grace window", () => {
    // Ticks at +5s (in grace), +10s and +15s (past it) reach the threshold.
    expect(run(Array<ProbeOutcome>(2).fill("unreachable")).kills).toBe(0);
    expect(run(Array<ProbeOutcome>(3).fill("unreachable")).kills).toBe(1);
  });

  it("does not kill twice for one failure streak", () => {
    const spawnedAt = 0;
    let state = initialHealthState(spawnedAt);
    const at = (tick: number): boolean => {
      const decision = applyProbe(state, "unreachable", tick * 5_000, limits);
      state = decision.state;
      return decision.kill;
    };
    expect([at(1), at(2), at(3), at(4)]).toEqual([false, false, true, false]);
  });

  it("kills a refusing sidecar without waiting out the grace window", () => {
    expect(run(["unhealthy", "unhealthy", "unhealthy"]).kills).toBe(1);
  });

  it("clears a failure streak when the sidecar answers again", () => {
    expect(run(["unreachable", "unreachable", "healthy"]).failures).toBe(0);
    expect(run(["unreachable", "unreachable", "warming"]).failures).toBe(0);
  });

  it("requires sustained health, not one probe, to clear the restart budget", () => {
    // Healthy from +5s: the run reaches stabilityMs only on the 7th tick.
    expect(run(Array<ProbeOutcome>(6).fill("healthy")).clears).toBe(0);
    expect(run(Array<ProbeOutcome>(8).fill("healthy")).clears).toBeGreaterThan(0);
  });

  it("restarts the stability clock after any non-healthy probe", () => {
    const outcomes: ProbeOutcome[] = [
      ...Array<ProbeOutcome>(5).fill("healthy"),
      "unreachable",
      ...Array<ProbeOutcome>(5).fill("healthy"),
    ];
    expect(run(outcomes).clears).toBe(0);
  });

  it("reproduces the reported restart loop under the previous policy", () => {
    // One failed probe killing the child, and any healthy probe clearing the
    // restart budget, is what let a slow startup loop forever.
    const previous: HealthPolicyLimits = {
      failureThreshold: 1,
      startupGraceMs: 0,
      stabilityMs: 0,
    };
    const cycle: ProbeOutcome[] = ["healthy", "unreachable"];
    const outcomes = Array.from({ length: 20 }, (_, i) => cycle[i % 2] as ProbeOutcome);
    expect(run(outcomes, previous)).toMatchObject({ kills: 10, clears: 10 });
    // The shipped policy neither kills nor forgives the restart budget here.
    expect(run(outcomes)).toMatchObject({ kills: 0, clears: 0 });
  });

  it("ships a grace window wider than the health interval and its timeout", () => {
    expect(DEFAULT_HEALTH_POLICY.startupGraceMs).toBeGreaterThan(
      DEFAULT_HEALTH_POLICY.failureThreshold * (5_000 + 3_000),
    );
  });
});
