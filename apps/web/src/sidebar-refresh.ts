import type { ApiClient, ThreadInfo } from "@/api-client";

interface SidebarRefreshHandlers {
  onThreads: (threads: ThreadInfo[]) => void;
}

export function createSidebarRefresh(
  client: Pick<ApiClient, "listThreads">,
  handlers: SidebarRefreshHandlers,
): () => Promise<ThreadInfo[] | undefined> {
  let latestThreadsRequest = 0;

  return async () => {
    const request = ++latestThreadsRequest;
    const threads = await client.listThreads();
    if (request !== latestThreadsRequest) return undefined;
    handlers.onThreads(threads);
    return threads;
  };
}

export interface ThreadCompletionRefresh {
  schedule: (threadIds: Iterable<string>) => void;
  dispose: () => void;
}

/**
 * Run completion precedes asynchronous title generation. Poll metadata for a
 * short bounded window so locally completed drafts are promoted even when the
 * thread-change stream misses a notification.
 */
export function createThreadCompletionRefresh(
  refresh: () => Promise<ThreadInfo[] | undefined>,
  onError: (message: string, error: unknown) => void,
  delays: readonly number[] = [0, 500, 1_500, 3_000, 6_000],
): ThreadCompletionRefresh {
  const pending = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let running = false;
  let rerun = false;

  const run = () => {
    if (disposed || pending.size === 0) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void refresh()
      .then((threads) => {
        if (!threads) return;
        const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
        for (const threadId of pending) {
          const thread = byId.get(threadId);
          if (thread && thread.title !== "New conversation") pending.delete(threadId);
        }
      })
      .catch((error) => onError("completed thread metadata refresh failed", error))
      .finally(() => {
        running = false;
        if (rerun) {
          rerun = false;
          run();
        }
      });
  };

  return {
    schedule: (threadIds) => {
      if (disposed) return;
      for (const threadId of threadIds) pending.add(threadId);
      if (pending.size === 0) return;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const delay of delays) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          run();
        }, delay);
        timers.add(timer);
      }
    },
    dispose: () => {
      disposed = true;
      pending.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export function subscribeSidebarRefresh(
  client: Pick<ApiClient, "watchThreadChanges">,
  refresh: () => Promise<unknown>,
  onError: (message: string, error: unknown) => void,
): () => void {
  const abort = new AbortController();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 1_000;
  let refreshRetryDelay = 1_000;
  let refreshRunning = false;
  let refreshPending = false;
  let pendingRefreshDelay = Number.POSITIVE_INFINITY;

  const scheduleRefresh = (delay = 25) => {
    if (abort.signal.aborted) return;
    refreshPending = true;
    pendingRefreshDelay = Math.min(pendingRefreshDelay, delay);
    if (refreshRunning || refreshTimer !== undefined) return;
    const scheduledDelay = pendingRefreshDelay;
    pendingRefreshDelay = Number.POSITIVE_INFINITY;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (abort.signal.aborted) return;
      refreshPending = false;
      refreshRunning = true;
      void refresh()
        .then(() => {
          refreshRetryDelay = 1_000;
        })
        .catch((error) => {
          onError("sidebar refresh failed", error);
          scheduleRefresh(refreshRetryDelay);
          refreshRetryDelay = Math.min(refreshRetryDelay * 2, 30_000);
        })
        .finally(() => {
          refreshRunning = false;
          if (refreshPending) scheduleRefresh(pendingRefreshDelay);
        });
    }, scheduledDelay);
  };

  const connect = async (): Promise<void> => {
    try {
      await client.watchThreadChanges(abort.signal, {
        onReady: () => {
          reconnectDelay = 1_000;
          scheduleRefresh();
        },
        onChange: () => scheduleRefresh(),
      });
    } catch (error) {
      if (!abort.signal.aborted) onError("thread event stream failed", error);
    }
    if (abort.signal.aborted) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  };

  void connect();
  return () => {
    abort.abort();
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  };
}
