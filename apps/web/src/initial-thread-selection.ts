import type { ThreadInfo } from "./api-client.js";

type InitialThread = Pick<ThreadInfo, "threadId" | "lastActivityAt">;

export function initialThreadId(rows: readonly InitialThread[]): string | null {
  const recency = (thread: InitialThread) =>
    thread.lastActivityAt ? Date.parse(thread.lastActivityAt) : 0;
  return rows.reduce<InitialThread | null>(
    (best, thread) =>
      best === null || recency(thread) > recency(best) ? thread : best,
    null,
  )?.threadId ?? null;
}
