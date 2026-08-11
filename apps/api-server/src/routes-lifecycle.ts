import { Hono } from "hono";
import type { AgentHost } from "./agent-host.js";

export function lifecycleRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.post("/lifecycle/suspend", (c) => {
    host.suspendForSystemSleep();
    return c.json({ ok: true });
  });

  app.post("/lifecycle/resume", async (c) => {
    await host.resumeFromSystemSleep();
    return c.json({ ok: true });
  });

  return app;
}
