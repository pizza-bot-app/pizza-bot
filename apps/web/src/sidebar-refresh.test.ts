import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadInfo } from "@/api-client";
import {
  createSidebarRefresh,
  createThreadCompletionRefresh,
  subscribeSidebarRefresh,
} from "./sidebar-refresh.js";

function thread(title: string): ThreadInfo {
  return {
    threadId: "thread-1",
    title,
    source: "user",
    pinned: false,
    unread: false,
    awaitingAction: false,
    createdAt: "",
    lastActivityAt: "",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("sidebar refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits thread metadata from one list request", async () => {
    const onThreads = vi.fn();
    const refresh = createSidebarRefresh(
      {
        listThreads: async () => [thread("Generated title")],
      },
      { onThreads },
    );

    await refresh();
    expect(onThreads).toHaveBeenCalledWith([thread("Generated title")]);
  });

  it("does not let an older refresh overwrite a newer thread list", async () => {
    const older = deferred<ThreadInfo[]>();
    const newer = deferred<ThreadInfo[]>();
    const onThreads = vi.fn();
    const listThreads = vi
      .fn<() => Promise<ThreadInfo[]>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const refresh = createSidebarRefresh(
      {
        listThreads,
      },
      { onThreads },
    );

    const first = refresh();
    const second = refresh();
    newer.resolve([thread("Generated title")]);
    await second;
    older.resolve([thread("New conversation")]);
    await first;

    expect(onThreads).toHaveBeenCalledTimes(1);
    expect(onThreads).toHaveBeenCalledWith([thread("Generated title")]);
  });

  it("polls completed local threads until generated titles are visible", async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<() => Promise<ThreadInfo[] | undefined>>()
      .mockResolvedValueOnce([thread("New conversation")])
      .mockResolvedValueOnce([thread("New conversation")])
      .mockResolvedValueOnce([thread("Generated title")]);
    const scheduler = createThreadCompletionRefresh(refresh, vi.fn(), [0, 100, 200, 300]);

    scheduler.schedule(["thread-1"]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(refresh).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it("coalesces a burst of completed threads into one polling sequence", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => [
      { ...thread("Generated title"), threadId: "thread-1" },
      { ...thread("Another title"), threadId: "thread-2" },
    ]);
    const scheduler = createThreadCompletionRefresh(refresh, vi.fn(), [0, 100]);

    scheduler.schedule(["thread-1"]);
    scheduler.schedule(["thread-2"]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("refreshes on ready and coalesces a burst of change events", async () => {
    vi.useFakeTimers();
    const stream = deferred<void>();
    let handlers:
      | { onReady: () => void; onChange: () => void }
      | undefined;
    const refresh = vi.fn(async () => {});
    const dispose = subscribeSidebarRefresh(
      {
        watchThreadChanges: async (_signal, nextHandlers) => {
          handlers = nextHandlers;
          return stream.promise;
        },
      },
      refresh,
      vi.fn(),
    );

    handlers!.onReady();
    handlers!.onChange();
    handlers!.onChange();
    await vi.advanceTimersByTimeAsync(25);

    expect(refresh).toHaveBeenCalledTimes(1);
    dispose();
    stream.resolve();
  });

  it("serializes refreshes and runs one trailing refresh for changes during a request", async () => {
    vi.useFakeTimers();
    const stream = deferred<void>();
    const firstRefresh = deferred<void>();
    let handlers:
      | { onReady: () => void; onChange: () => void }
      | undefined;
    let concurrent = 0;
    let maxConcurrent = 0;
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await firstRefresh.promise;
        concurrent--;
      })
      .mockImplementationOnce(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        concurrent--;
      });
    const dispose = subscribeSidebarRefresh(
      {
        watchThreadChanges: async (_signal, nextHandlers) => {
          handlers = nextHandlers;
          return stream.promise;
        },
      },
      refresh,
      vi.fn(),
    );

    handlers!.onReady();
    await vi.advanceTimersByTimeAsync(25);
    handlers!.onChange();
    handlers!.onChange();
    await vi.advanceTimersByTimeAsync(25);
    expect(refresh).toHaveBeenCalledTimes(1);

    firstRefresh.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    dispose();
    stream.resolve();
  });

  it("retries a failed initial list refresh without waiting for another event", async () => {
    vi.useFakeTimers();
    const stream = deferred<void>();
    let handlers:
      | { onReady: () => void; onChange: () => void }
      | undefined;
    const failure = new Error("offline");
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const onError = vi.fn();
    const dispose = subscribeSidebarRefresh(
      {
        watchThreadChanges: async (_signal, nextHandlers) => {
          handlers = nextHandlers;
          return stream.promise;
        },
      },
      refresh,
      onError,
    );

    handlers!.onReady();
    await vi.advanceTimersByTimeAsync(25);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("sidebar refresh failed", failure);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    dispose();
    stream.resolve();
  });

  it("reconnects after a stream ends and aborts the active connection on dispose", async () => {
    vi.useFakeTimers();
    const secondStream = deferred<void>();
    const signals: AbortSignal[] = [];
    const watchThreadChanges = vi
      .fn<(signal: AbortSignal, handlers: { onReady: () => void; onChange: () => void }) => Promise<void>>()
      .mockImplementationOnce(async (signal, handlers) => {
        signals.push(signal);
        handlers.onReady();
      })
      .mockImplementationOnce(async (signal, handlers) => {
        signals.push(signal);
        handlers.onReady();
        return secondStream.promise;
      });
    const dispose = subscribeSidebarRefresh(
      { watchThreadChanges },
      vi.fn(async () => {}),
      vi.fn(),
    );

    await Promise.resolve();
    expect(watchThreadChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchThreadChanges).toHaveBeenCalledTimes(2);

    dispose();
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(true);
    secondStream.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(watchThreadChanges).toHaveBeenCalledTimes(2);
  });
});
