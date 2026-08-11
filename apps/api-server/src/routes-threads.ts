import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentHost } from "./agent-host.js";

let forkCounter = 0;
const newThreadId = () => `thread_${Date.now().toString(36)}_${forkCounter++}`;

const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;

// Checkpoint state may contain live LangChain messages or their serialized form.
export interface ForkMessage {
  id?: string | string[];
  getType?: () => string;
  tool_calls?: Array<{ id?: string }>;
  tool_call_id?: string;
  kwargs?: {
    id?: unknown;
    tool_calls?: Array<{ id?: string }>;
    tool_call_id?: string;
  };
}

export function classOf(m: ForkMessage): string | null {
  if (typeof m.getType === "function") return m.getType();
  if (Array.isArray(m.id)) {
    const cls = m.id[m.id.length - 1] ?? "";
    if (cls === "HumanMessage") return "human";
    if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
    if (cls === "ToolMessage") return "tool";
    if (cls === "SystemMessage") return "system";
  }
  return null;
}

export function msgId(m: ForkMessage): string | undefined {
  if (typeof m.id === "string") return m.id;
  if (typeof m.kwargs?.id === "string") return m.kwargs.id;
  return undefined;
}

function toolCalls(m: ForkMessage): Array<{ id?: string }> {
  return m.tool_calls ?? m.kwargs?.tool_calls ?? [];
}

function toolCallId(m: ForkMessage): string | undefined {
  return m.tool_call_id ?? m.kwargs?.tool_call_id;
}

export function sliceForFork(history: ForkMessage[], messageId: string): ForkMessage[] {
  const idx = history.findIndex((m) => msgId(m) === messageId);
  if (idx < 0) return [];

  let end = idx + 1;
  const boundary = history[idx]!;
  const openCalls = new Set<string>();
  if (classOf(boundary) === "ai") {
    for (const tc of toolCalls(boundary)) {
      if (tc.id) openCalls.add(tc.id);
    }
  }
  while (openCalls.size > 0 && end < history.length) {
    const next = history[end]!;
    if (classOf(next) === "tool") {
      const tcid = toolCallId(next);
      if (tcid && openCalls.has(tcid)) {
        openCalls.delete(tcid);
        end += 1;
        continue;
      }
    }
    break;
  }

  // Never retain an AI tool call without all of its matching ToolMessages.
  if (openCalls.size > 0) return history.slice(0, idx);
  return history.slice(0, end);
}

export function forkBoundaryError(history: ForkMessage[], messageId: string): string | null {
  const idx = history.findIndex((m) => msgId(m) === messageId);
  if (idx < 0) return "messageId not found in thread history";
  const boundary = history[idx]!;
  if (classOf(boundary) !== "ai") {
    return "can only fork at a completed assistant turn";
  }
  const openCalls = new Set<string>();
  for (const tc of toolCalls(boundary)) {
    if (tc.id) openCalls.add(tc.id);
  }
  let end = idx + 1;
  while (openCalls.size > 0 && end < history.length) {
    const next = history[end]!;
    if (classOf(next) === "tool") {
      const tcid = toolCallId(next);
      if (tcid && openCalls.has(tcid)) {
        openCalls.delete(tcid);
        end += 1;
        continue;
      }
    }
    break;
  }
  if (openCalls.size > 0) return "cannot fork mid-tool-call (unresolved tool_calls)";
  return null;
}

export function threadRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/threads/list", (c) => c.json(host.threadStore.list()));

  app.get("/threads/activity/events", (c) => {
    const signal = c.req.raw.signal;
    const rawSince = c.req.query("since");
    const parsedSince = rawSince === undefined ? undefined : Number(rawSince);
    const requestedSince =
      parsedSince !== undefined &&
      Number.isSafeInteger(parsedSince) &&
      parsedSince >= 0
        ? parsedSince
        : undefined;
    return streamSSE(c, async (stream) => {
      let cursor = requestedSince ?? 0;
      let changeVersion = 0;
      let wake: (() => void) | undefined;
      const waitForChange = (observedVersion: number) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            if (wake === done) wake = undefined;
            resolve();
          };
          wake = done;
          const timer = setTimeout(done, 15_000);
          (timer as { unref?: () => void }).unref?.();
          if (signal.aborted || changeVersion !== observedVersion) done();
        });
      const unsubscribe = host.threadActivity.subscribe(() => {
        changeVersion++;
        wake?.();
      });
      if (requestedSince === undefined) {
        cursor = host.threadActivity.latestSeq();
      }
      const onAbort = () => wake?.();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        await stream.writeSSE({
          event: "ready",
          data: JSON.stringify({ cursor }),
        });
        while (!signal.aborted) {
          const observedVersion = changeVersion;
          const events = host.threadActivity.listAfter(cursor);
          if (events.length > 0) {
            for (const event of events) {
              await stream.writeSSE({
                event: "activity",
                id: String(event.seq),
                data: JSON.stringify(event),
              });
              cursor = event.seq;
            }
            continue;
          }
          if (changeVersion !== observedVersion) {
            continue;
          }
          await waitForChange(observedVersion);
          if (!signal.aborted && changeVersion === observedVersion) {
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    });
  });

  app.get("/threads/events", (c) => {
    const signal = c.req.raw.signal;
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let changed = false;
      let wake: (() => void) | undefined;
      const waitForChange = () =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            if (wake === done) wake = undefined;
            resolve();
          };
          wake = done;
          const timer = setTimeout(done, 15_000);
          (timer as { unref?: () => void }).unref?.();
        });
      const unsubscribe = host.threadStore.subscribe(() => {
        changed = true;
        wake?.();
      });
      const onAbort = () => wake?.();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Subscription is active before ready is sent, so a list fetched after
        // ready cannot miss a concurrent metadata change.
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!signal.aborted) {
          if (!changed) {
            await waitForChange();
          }
          if (signal.aborted) break;
          if (!changed) {
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
            continue;
          }
          changed = false;
          await stream.writeSSE({ event: "changed", data: "{}" });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    });
  });

  app.get("/threads/search", (c) => {
    const q = c.req.query("q") ?? "";
    const requested = Number(c.req.query("limit") ?? SEARCH_LIMIT_DEFAULT);
    // SQLite treats a negative LIMIT as unbounded.
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), SEARCH_LIMIT_MAX)
      : SEARCH_LIMIT_DEFAULT;
    return c.json(host.search.search(q, limit));
  });

  app.patch("/threads/:thread_id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      pinned?: boolean;
      title?: string;
      unread?: boolean;
    };
    const patch: {
      pinned?: boolean;
      title?: string;
      unread?: boolean;
    } = {};
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.unread === "boolean") patch.unread = body.unread;
    const record = host.threadStore.update(c.req.param("thread_id"), patch);
    if (!record) return c.json({ error: "thread not found" }, 404);
    return c.json(record);
  });

  app.delete("/threads/:thread_id", async (c) => {
    const deleted = await host.deleteThread(c.req.param("thread_id"));
    return c.json({ deleted });
  });

  app.post("/threads/:thread_id/fork", async (c) => {
    const sourceThreadId = c.req.param("thread_id");
    const body = (await c.req.json().catch(() => ({}))) as {
      messageId?: string;
      messageIndex?: number;
      title?: string;
    };
    if (!body.messageId && typeof body.messageIndex !== "number") {
      return c.json({ error: "body.messageId or body.messageIndex is required" }, 400);
    }
    // Forking an active thread could capture a partially-written model cycle.
    if (host.protocolRuns.isRunning(sourceThreadId)) {
      return c.json({ error: "cannot fork a thread while a run is active" }, 409);
    }

    const source = host.threadStore.get(sourceThreadId);
    const state = await host.agent.getState(sourceThreadId);
    const history = ((state.values as { messages?: ForkMessage[] } | undefined)?.messages ?? []);
    if (history.length === 0) {
      return c.json({ error: "source thread has no history" }, 404);
    }

    let resolvedId = body.messageId;
    if (!resolvedId) {
      const i = body.messageIndex as number;
      if (i < 0 || i >= history.length) {
        return c.json({ error: "messageIndex out of range" }, 400);
      }
      resolvedId = msgId(history[i]!);
      if (!resolvedId) return c.json({ error: "target message has no id" }, 400);
    }

    const boundaryError = forkBoundaryError(history, resolvedId);
    if (boundaryError) {
      return c.json({ error: boundaryError }, 400);
    }

    const slice = sliceForFork(history, resolvedId);
    if (slice.length === 0) {
      return c.json({ error: "messageId not found in thread history" }, 400);
    }

    const forkId = newThreadId();
    // The messages reducer is additive and the new checkpoint starts empty.
    await host.agent.updateState(forkId, { messages: slice });

    const record = host.threadStore.create({
      threadId: forkId,
      title: body.title ?? `${source?.title ?? "Conversation"} (fork)`,
      source: "fork",
      parentThreadId: sourceThreadId,
      parentCheckpointId: state.checkpointId,
      ...(source?.modelId ? { modelId: source.modelId } : {}),
    });
    // Make the fork searchable before its first run triggers normal maintenance.
    host.search.reindexThread(forkId, slice as import("@pizza-bot/storage").IndexableMessage[]);

    return c.json(record, 201);
  });

  return app;
}
