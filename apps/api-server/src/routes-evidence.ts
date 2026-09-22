/**
 * Read-only views of a thread's evidence ledger. There is no write route by design:
 * only the server-side tool middleware records evidence, so nothing the agent or the
 * browser sends can forge provenance.
 */
import { Hono } from "hono";
import type { AgentHost } from "./agent-host.js";

export function evidenceRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/threads/:thread_id/evidence", (c) => {
    const store = host.evidence;
    if (!store) return c.json({ error: "evidence_disabled" }, 409);
    return c.json({ evidence: store.listByThread(c.req.param("thread_id")) });
  });

  app.get("/evidence/:id", (c) => {
    const store = host.evidence;
    if (!store) return c.json({ error: "evidence_disabled" }, 409);
    const id = c.req.param("id");
    const meta = store.get(id);
    const body = meta ? store.readBody(id) : undefined;
    if (!meta || body === undefined) return c.json({ error: "not_found" }, 404);
    return c.json({ ...meta, body });
  });

  return app;
}
