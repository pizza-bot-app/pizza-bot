/**
 * Read-only views of a thread's provenance: the evidence ledger, and the verdicts
 * recorded when a reviewer dispatched a gated action. There are no write routes by
 * design, so nothing the agent or the browser sends can forge either one.
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

  // The tiers are served as they were stored, not recomputed: a reviewer must be able to
  // read what the audit said when the action went out, even if the source has since changed.
  app.get("/threads/:thread_id/approval-verdicts", (c) =>
    c.json({ verdicts: host.approvalVerdicts.listByThread(c.req.param("thread_id")) }),
  );

  return app;
}
