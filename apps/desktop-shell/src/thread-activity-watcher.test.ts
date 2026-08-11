import { describe, expect, it, vi } from "vitest";
import type { ThreadActivityEvent } from "@pizza-bot/core";
import {
  ThreadActivityWatcher,
  notificationForThreadActivity,
} from "./thread-activity-watcher.js";

function activity(
  seq: number,
  outcome: ThreadActivityEvent["outcome"],
  threadId = "thread-1",
): ThreadActivityEvent {
  return {
    seq,
    eventId: `event-${seq}`,
    threadId,
    runId: `run-${seq}`,
    outcome,
    interruptIds: outcome === "interrupted" ? ["approval"] : [],
    threadTitle: "Quarterly report",
    createdAt: "2026-08-09T10:00:00.000Z",
  };
}

function sseResponse(
  events: string,
  options: { close?: boolean } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      if (options.close !== false) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function eventSse(event: ThreadActivityEvent): string {
  return `id: ${event.seq}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("thread activity watcher", () => {
  it("maps terminal outcomes to notifications except cancellation", () => {
    expect(notificationForThreadActivity(activity(1, "success"))).toMatchObject({
      kind: "run-complete",
    });
    expect(notificationForThreadActivity(activity(2, "error"))).toMatchObject({
      kind: "run-failed",
      reason: "error",
    });
    expect(notificationForThreadActivity(activity(3, "timeout"))).toMatchObject({
      kind: "run-failed",
      reason: "timeout",
    });
    expect(
      notificationForThreadActivity(activity(4, "interrupted")),
    ).toMatchObject({ kind: "action-required" });
    expect(notificationForThreadActivity(activity(5, "cancelled"))).toBeUndefined();
  });

  it("silently baselines, then emits every later actionable or finished run", async () => {
    const notify = vi.fn();
    const old = activity(4, "success");
    const success = activity(5, "success");
    const error = activity(6, "error");
    const timeout = activity(7, "timeout");
    const firstInterrupt = activity(8, "interrupted");
    const repeatedInterrupt = activity(9, "interrupted");
    const cancelled = activity(10, "cancelled");
    const fetch = vi.fn(async () =>
      sseResponse(
        [
          'event: ready\ndata: {"cursor":4}\n\n',
          eventSse(old),
          eventSse(success),
          eventSse(error),
          eventSse(timeout),
          eventSse(firstInterrupt),
          eventSse(repeatedInterrupt),
          eventSse(cancelled),
        ].join(""),
      ),
    );
    const watcher = new ThreadActivityWatcher({
      fetch: fetch as unknown as typeof globalThis.fetch,
      notify,
      reconnectDelayMs: 10_000,
    });

    watcher.setConnection({
      sourceId: "local",
      apiBase: "http://127.0.0.1:4312/",
      apiToken: "secret",
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(5));
    watcher.stop();

    expect(notify.mock.calls.map(([request]) => request.kind)).toEqual([
      "run-complete",
      "run-failed",
      "run-failed",
      "action-required",
      "action-required",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4312/threads/activity/events",
      expect.objectContaining({
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer secret",
        },
      }),
    );
  });

  it("reconnects with the latest cursor", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(
          `event: ready\ndata: {"cursor":4}\n\n${eventSse(activity(5, "success"))}`,
        ),
      )
      .mockResolvedValueOnce(
        sseResponse('event: ready\ndata: {"cursor":5}\n\n', {
          close: false,
        }),
      );
    const watcher = new ThreadActivityWatcher({
      fetch: fetch as unknown as typeof globalThis.fetch,
      notify: vi.fn(),
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    watcher.setConnection({
      sourceId: "local",
      apiBase: "http://127.0.0.1:4312",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    watcher.stop();

    expect(fetch.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:4312/threads/activity/events",
    );
    expect(fetch.mock.calls[1]![0]).toBe(
      "http://127.0.0.1:4312/threads/activity/events?since=5",
    );
  });

  it("forces a cursor-preserving reconnect for the same connection", async () => {
    const notify = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(
          `event: ready\ndata: {"cursor":0}\n\n${eventSse(activity(1, "success"))}`,
          { close: false },
        ),
      )
      .mockResolvedValueOnce(
        sseResponse('event: ready\ndata: {"cursor":1}\n\n', {
          close: false,
        }),
      );
    const watcher = new ThreadActivityWatcher({
      fetch: fetch as unknown as typeof globalThis.fetch,
      notify,
      reconnectDelayMs: 10_000,
    });
    const connection = {
      sourceId: "local",
      apiBase: "http://127.0.0.1:4312",
    };

    watcher.setConnection(connection);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    watcher.setConnection(connection);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    watcher.stop();

    expect(fetch.mock.calls[1]![0]).toBe(
      "http://127.0.0.1:4312/threads/activity/events?since=1",
    );
  });

  it("preserves a cursor across endpoint rotation and resets it for a new source", async () => {
    const notify = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(
          `event: ready\ndata: {"cursor":0}\n\n${eventSse(activity(1, "success"))}`,
          { close: false },
        ),
      )
      .mockResolvedValueOnce(
        sseResponse('event: ready\ndata: {"cursor":1}\n\n', {
          close: false,
        }),
      )
      .mockResolvedValueOnce(
        sseResponse('event: ready\ndata: {"cursor":20}\n\n', {
          close: false,
        }),
      );
    const watcher = new ThreadActivityWatcher({
      fetch: fetch as unknown as typeof globalThis.fetch,
      notify,
      reconnectDelayMs: 10_000,
    });

    watcher.setConnection({ sourceId: "local", apiBase: "http://one" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    watcher.setConnection({ sourceId: "local", apiBase: "http://two" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    watcher.setConnection({ sourceId: "remote:http://three", apiBase: "http://three" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    watcher.stop();

    expect(fetch.mock.calls[1]![0]).toBe(
      "http://two/threads/activity/events?since=1",
    );
    expect(fetch.mock.calls[2]![0]).toBe(
      "http://three/threads/activity/events",
    );
  });
});
