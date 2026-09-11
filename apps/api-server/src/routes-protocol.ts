import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentHost } from "./agent-host.js";
import type { ProtocolFilter } from "./protocol-run-manager.js";
import {
  type ProtocolCommand,
  dispatchProtocolCommand,
  ProtocolCommandError,
  toProtocolState,
} from "./protocol-commands.js";

const STREAM_HEARTBEAT_MS = 10_000;

export function protocolRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.post("/threads/:thread_id/commands", async (c) => {
    const runs = host.protocolRuns;
    if (!runs) return c.json({ type: "error", id: null, error: "not_supported", message: "protocol seam disabled" }, 501);

    const threadId = c.req.param("thread_id");
    const body: unknown = await c.req.json().catch(() => undefined);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        { type: "error", id: null, error: "invalid_argument", message: "command body must be a JSON object" },
        400,
      );
    }
    const cmd = body as ProtocolCommand;
    try {
      const outcome = await dispatchProtocolCommand({
        runs,
        threadId,
        command: cmd,
        stateReader: {
          getState: async (id) => {
            await host.whenReady();
            return host.agent.getState(id);
          },
        },
      });
      if (outcome.kind === "success") {
        if (cmd.method === "input.respond") {
          await host.clearThreadAwaitingAction(threadId);
        }
        // The SDK waits for this acknowledgement before opening its event stream.
        return c.json({ type: "success", id: outcome.id, result: outcome.result });
      }
      if (outcome.kind === "cancellation_pending") {
        return c.json(
          {
            type: "error",
            id: outcome.id,
            error: "cancellation_pending",
            message: "run did not stop before the cancellation deadline",
          },
          409,
        );
      }
      if (outcome.kind === "unknown_command") {
        // The SDK reads an empty 2xx as "applied", so an unknown method must fail
        // loudly. 422 is on the SDK caller's no-retry list; 418 and 501 are not.
        return c.json(
          {
            type: "error",
            id: cmd.id ?? null,
            error: "unknown_command",
            message: `unknown command method ${JSON.stringify(outcome.method)}`,
          },
          422,
        );
      }
      // run.stop acknowledgement (stopped, or nothing to stop): the SDK treats
      // an empty 204 as applied.
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof ProtocolCommandError) {
        return c.json(
          { type: "error", id: cmd.id ?? null, error: error.code, message: error.message },
          400,
        );
      }
      throw error;
    }
  });

  app.post("/threads/:thread_id/runs/:run_id/cancel", async (c) => {
    // SDK stop() uses this REST route rather than run.stop. Matching runId keeps
    // a delayed cancellation from aborting a replacement run on the same thread.
    const runs = host.protocolRuns;
    if (!runs) return c.json({ error: "protocol seam disabled" }, 501);
    const threadId = c.req.param("thread_id");
    const runId = c.req.param("run_id");
    const result = await runs.cancelAndWait(threadId, runId);
    if (result.accepted && !result.settled) {
      return c.json(
        { run_id: runId, status: "cancellation_pending", error: "run did not stop before the cancellation deadline" },
        409,
      );
    }
    return c.json({ run_id: runId, status: result.accepted ? "cancelled" : "no_run" });
  });

  app.post("/threads/:thread_id/stream/events", async (c) => {
    const runs = host.protocolRuns;
    if (!runs) return c.json({ error: "protocol seam disabled" }, 501);

    const threadId = c.req.param("thread_id");
    const body = (await c.req.json().catch(() => ({}))) as Partial<ProtocolFilter>;
    const filter: ProtocolFilter = {
      channels: Array.isArray(body.channels) ? body.channels : [],
      ...(Array.isArray(body.namespaces) ? { namespaces: body.namespaces } : {}),
      ...(typeof body.depth === "number" ? { depth: body.depth } : {}),
      ...(typeof body.since === "number" ? { since: body.since } : {}),
    };

    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });

    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const heartbeat = setInterval(() => {
        void stream.write(": heartbeat\n\n");
      }, STREAM_HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        for await (const ev of runs.observe(threadId, filter, ac.signal)) {
          if (ac.signal.aborted) break;
          // Both cursors carry the manager sequence used for reconnect replay.
          await stream.writeSSE({
            ...(typeof ev.seq === "number" ? { id: String(ev.seq) } : {}),
            data: JSON.stringify(ev),
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  app.get("/threads/:thread_id/state", async (c) => {
    await host.whenReady();
    const threadId = c.req.param("thread_id");
    const state = await host.agent.getState(threadId);
    return c.json(toProtocolState(state));
  });

  return app;
}
