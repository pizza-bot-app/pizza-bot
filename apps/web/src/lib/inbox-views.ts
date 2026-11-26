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

/**
 * Server rows plus a placeholder for each open or locally known thread the server
 * does not list. A work thread drops out of the server list once answered, so its
 * placeholder keeps the `background` flag and stays out of the Inbox views.
 */
export function mergeThreadRows(
  listed: readonly ThreadInfo[],
  local: Iterable<string>,
  titles: ReadonlyMap<string, string> | undefined,
  backgroundIds: ReadonlySet<string> | undefined,
): ThreadInfo[] {
  const known = new Map<string, ThreadInfo>();
  for (const t of listed) {
    const title = titles?.get(t.threadId);
    known.set(t.threadId, title && title !== t.title ? { ...t, title } : t);
  }
  for (const id of local) {
    if (known.has(id)) continue;
    known.set(id, {
      threadId: id,
      title: titles?.get(id) ?? "New conversation",
      source: "user",
      pinned: false,
      unread: false,
      awaitingAction: false,
      createdAt: "",
      lastActivityAt: "",
      ...(backgroundIds?.has(id) ? { background: true as const } : {}),
    });
  }
  return [...known.values()];
}

