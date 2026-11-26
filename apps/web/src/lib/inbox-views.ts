/** Inbox filters: an agent's background work threads show only in the Action view. */
import type { ThreadInfo } from "@/api-client";

export type InboxFilter = "all" | "unread" | "action" | "unfiled" | `folder:${string}`;

type FilterableThread = Pick<ThreadInfo, "threadId" | "awaitingAction" | "folderId" | "background">;

export function inboxThreads<T extends FilterableThread>(
  rows: readonly T[],
  filter: InboxFilter,
  isUnread: (thread: T) => boolean,
): T[] {
  if (filter === "action") return rows.filter((thread) => thread.awaitingAction);
  const listed = rows.filter((thread) => !thread.background);
  if (filter === "unread") return listed.filter(isUnread);
  if (filter === "unfiled") return listed.filter((thread) => !thread.folderId);
  if (filter.startsWith("folder:")) {
    const folderId = filter.slice("folder:".length);
    return listed.filter((thread) => thread.folderId === folderId);
  }
  return listed;
}
