import { Hono } from "hono";
import type { AgentHost } from "./agent-host.js";
import { toProtocolState } from "./protocol-commands.js";

let threadCounter = 0;
const newThreadId = () => `thread_${Date.now().toString(36)}_${threadCounter++}`;

export function langGraphRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.post("/threads", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      thread_id?: string;
      metadata?: { folder_id?: unknown };
    };
    const threadId = body.thread_id ?? newThreadId();
    const folderId = body.metadata?.folder_id;
    if (folderId !== undefined) {
      if (typeof folderId !== "string") {
        return c.json({ error: "metadata.folder_id must be a string" }, 400);
      }
      if (!host.folderStore.get(folderId)) {
        return c.json({ error: "folder not found" }, 404);
      }
      host.threadStore.ensure({ threadId, folderId });
    }
    const now = new Date().toISOString();
    return c.json({
      thread_id: threadId,
      status: "idle",
      metadata: folderId === undefined ? {} : { folder_id: folderId },
      created_at: now,
      updated_at: now,
    });
  });

  app.post("/threads/:thread_id/state", async (c) => {
    await host.whenReady();
    const body = await c.req.json().catch(() => ({}));
    const { values, as_node } = body as { values?: unknown; as_node?: string };
    const threadId = c.req.param("thread_id");
    const cp = await host.agent.updateState(threadId, values, as_node);
    return c.json({ checkpoint_id: cp.checkpointId, thread_id: cp.threadId });
  });

  app.get("/threads/:thread_id/history", async (c) => {
    await host.whenReady();
    return c.json(await collectHistory(host, c.req.param("thread_id")));
  });

  // The LangGraph SDK uses POST for paginated history queries.
  app.post("/threads/:thread_id/history", async (c) => {
    await host.whenReady();
    const body = (await c.req.json().catch(() => ({}))) as {
      limit?: number;
      before?: { configurable?: { checkpoint_id?: string } } | string;
      checkpoint?: { checkpoint_ns?: string };
    };
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 10;
    const before =
      typeof body.before === "string" ? body.before : body.before?.configurable?.checkpoint_id;
    // A scoped `checkpoint_ns` narrows history to a subagent subgraph's own
    // transcript; without it the SDK's scoped projection would seed from the
    // root thread and mirror the whole conversation into the delegation card.
    const checkpointNs = body.checkpoint?.checkpoint_ns;
    return c.json(
      await collectHistory(host, c.req.param("thread_id"), {
        limit,
        ...(before != null ? { before } : {}),
        ...(checkpointNs ? { checkpointNs } : {}),
      }),
    );
  });

  return app;
}

async function collectHistory(
  host: AgentHost,
  threadId: string,
  opts?: { limit?: number; before?: string; checkpointNs?: string },
): Promise<unknown[]> {
  const out: unknown[] = [];
  let skipping = opts?.before != null;
  for await (const s of host.agent.getStateHistory(threadId, opts?.checkpointNs)) {
    if (skipping) {
      // The SDK's before cursor is exclusive, so omit the matching checkpoint too.
      if (s.checkpointId === opts!.before) skipping = false;
      continue;
    }
    out.push(toProtocolState(s));
    if (opts?.limit != null && out.length >= opts.limit) break;
  }
  return out;
}
