import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { parseGraphSpec } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

export function graphRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/graphs", async (c) => c.json(await host.graphRegistry.list()));

  app.get("/graphs/:id", async (c) => {
    const spec = await host.graphRegistry.get(c.req.param("id"));
    return spec ? c.json(spec) : c.json({ error: "not_found" }, 404);
  });

  app.put("/graphs/:id", async (c) => {
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "invalid", detail: ["body must be a graph spec object"] }, 400);
    }
    const parsed = parseGraphSpec({ ...body, id });
    if (!parsed.ok) return c.json({ error: "invalid", detail: parsed.errors }, 400);
    await host.graphRegistry.put(parsed.spec);
    return c.json(parsed.spec);
  });

  app.delete("/graphs/:id", async (c) => {
    const id = c.req.param("id");
    const targetedBy = host.triggers.list().filter((t) => t.graphId === id).map((t) => t.id);
    if (targetedBy.length > 0) {
      return c.json({ error: "in_use", detail: `triggers ${targetedBy.join(", ")} run this graph` }, 409);
    }
    // A graph thread resolves its state through its spec, so deleting the spec would strand its runs.
    const runs = host.threadStore.listByGraph(id).length;
    if (runs > 0) {
      return c.json({ error: "in_use", detail: `${runs} run${runs === 1 ? "" : "s"} of this graph still exist; delete them first` }, 409);
    }
    return (await host.graphRegistry.delete(id))
      ? c.json({ deleted: true })
      : c.json({ error: "not_found" }, 404);
  });

  app.get("/graphs/:id/runs", (c) => {
    const id = c.req.param("id");
    return c.json(host.threadStore.listByGraph(id));
  });

  app.post("/graphs/:id/runs", async (c) => {
    const id = c.req.param("id");
    if (!(await host.graphRegistry.get(id))) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown };
    const input = body.input ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return c.json({ error: "invalid", detail: ["input must be an object"] }, 400);
    }
    const threadId = `thread_graph_${randomUUID()}`;
    const { runId } = host.protocolRuns.start(
      threadId,
      { graphInput: input as Record<string, unknown> },
      { configurable: { graph_id: id } },
    );
    return c.json({ thread_id: threadId, run_id: runId }, 201);
  });

  return app;
}
