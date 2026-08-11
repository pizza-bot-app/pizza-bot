import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "./agent-host.js";
import { lifecycleRoutes } from "./routes-lifecycle.js";

describe("lifecycle routes", () => {
  it("coordinates suspend and resume with the host", async () => {
    const suspendForSystemSleep = vi.fn();
    const resumeFromSystemSleep = vi.fn(async () => {});
    const app = lifecycleRoutes({
      suspendForSystemSleep,
      resumeFromSystemSleep,
    } as unknown as AgentHost);

    await expect(
      (await app.request("/lifecycle/suspend", { method: "POST" })).json(),
    ).resolves.toEqual({ ok: true });
    await expect(
      (await app.request("/lifecycle/resume", { method: "POST" })).json(),
    ).resolves.toEqual({ ok: true });
    expect(suspendForSystemSleep).toHaveBeenCalledOnce();
    expect(resumeFromSystemSleep).toHaveBeenCalledOnce();
  });
});
