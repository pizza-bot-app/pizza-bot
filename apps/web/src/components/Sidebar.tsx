import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Search,
  X,
  ChevronDown,
  Loader2,
  Pen,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import type { ApiClient, ThreadInfo, SearchHit } from "@/api-client";
import { useKnownThreadIds, useRunningThreadIds } from "../use-thread-slice.js";
import { datePeriod, PERIOD_ORDER, relativeTime, type DatePeriod } from "../lib/conversation.js";
import { selectionAfterDelete } from "../lib/list-nav.js";
import {
  useHotkey,
  useLayer,
  useHotkeyChord,
  useThreadIndexHotkeys,
} from "../hotkeys/index.js";
import {
  SELECTABLE_LIST_ZONE,
  useSelectableListNavigation,
} from "../use-selectable-list-navigation.js";
import {
  createSidebarRefresh,
  createThreadCompletionRefresh,
  subscribeSidebarRefresh,
} from "../sidebar-refresh.js";
import { protocolStreamStore } from "../protocol-stream-store.js";
import { createConversationSearch } from "../conversation-search.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { useAppToast } from "./AppToast.js";

export interface SidebarProps {
  client: ApiClient;
  openedThreads: ReadonlySet<string>;
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenSearchHit?: (hit: SearchHit) => void;
  onDeleted: (threadId: string) => void;
  onThreadsLoaded?: (rows: ThreadInfo[]) => void;
  threadTitles?: ReadonlyMap<string, string>;
  listRef?: React.RefObject<HTMLDivElement | null>;
  onFocusComposer?: () => void;
}

type Filter = "all" | "unread" | "action";

export function Sidebar({
  client,
  openedThreads,
  activeThreadId,
  onSelect,
  onNewChat,
  onOpenThread,
  onOpenSearchHit,
  onDeleted,
  onThreadsLoaded,
  threadTitles,
  listRef,
  onFocusComposer,
}: SidebarProps) {
  const notify = useAppToast();
  const localKnown = useKnownThreadIds();
  const localRunning = useRunningThreadIds();
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set<string>(["Last Week", "This Month", "Older"]),
  );
  const [confirmDelete, setConfirmDelete] = useState<ThreadInfo | null>(null);
  const threadListRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const deleteDialogWasOpen = useRef(false);
  const messageSearchRef = useRef<ReturnType<typeof createConversationSearch> | null>(null);
  const setThreadListElement = useCallback(
    (element: HTMLDivElement | null) => {
      threadListRef.current = element;
      if (listRef) listRef.current = element;
    },
    [listRef],
  );

  const refresh = useMemo(
    () =>
      createSidebarRefresh(client, {
        onThreads: (list) => {
          setThreads(list);
          onThreadsLoaded?.(list);
        },
      }),
    [client, onThreadsLoaded],
  );

  const completionRefresh = useMemo(
    () =>
      createThreadCompletionRefresh(refresh, (message, error) =>
        console.error(message, error),
      ),
    [refresh],
  );

  useEffect(() => {
    return subscribeSidebarRefresh(client, refresh, (message, error) =>
      console.error(message, error),
    );
  }, [client, refresh]);

  useEffect(() => () => completionRefresh.dispose(), [completionRefresh]);

  useEffect(() => {
    return protocolStreamStore.subscribeRunCompletions((threadId) => {
      completionRefresh.schedule([threadId]);
    });
  }, [completionRefresh]);

  useEffect(() => {
    if (!activeThreadId) return;
    const active = threads.find((t) => t.threadId === activeThreadId);
    if (!active?.unread) return;
    // A metadata refresh may mark a visible thread unread when its run finishes. Clear it
    // locally first to avoid a badge flash while the server catches up.
    setThreads((prev) =>
      prev.map((t) => (t.threadId === activeThreadId ? { ...t, unread: false } : t)),
    );
    client.markThreadRead(activeThreadId).catch((err) => console.error("mark read failed", err));
  }, [activeThreadId, threads, client]);

  const onPinToggle = useCallback(
    async (t: ThreadInfo) => {
      try {
        await client.setThreadPinned(t.threadId, !t.pinned);
        await refresh();
      } catch (err) {
        console.error("pin toggle failed", err);
        notify({
          title: t.pinned ? "Could not unpin conversation" : "Could not pin conversation",
          description: err instanceof Error ? err.message : undefined,
          tone: "error",
        });
      }
    },
    [client, notify, refresh],
  );

  // The dialog layer keeps Enter and Escape from reaching list/global bindings.
  useLayer("sidebar-delete", {
    active: !!confirmDelete,
    onEscape: () => setConfirmDelete(null),
  });

  useEffect(() => {
    if (confirmDelete) {
      deleteDialogWasOpen.current = true;
      return;
    }
    if (!deleteDialogWasOpen.current) return;
    deleteDialogWasOpen.current = false;
    threadListRef.current?.focus();
  }, [confirmDelete]);

  useEffect(() => {
    const messageSearch = createConversationSearch(client, {
      onHits: setHits,
      onSearching: setSearching,
      onError: (error) => {
        console.error("conversation search failed", error);
        notify({
          title: "Search unavailable",
          description: error instanceof Error ? error.message : undefined,
          tone: "error",
        });
      },
    });
    messageSearchRef.current = messageSearch;
    return () => {
      if (messageSearchRef.current === messageSearch) messageSearchRef.current = null;
      messageSearch.dispose();
    };
  }, [client, notify]);

  const onQueryChange = useCallback(
    (q: string) => {
      setQuery(q);
      messageSearchRef.current?.query(q);
    },
    [],
  );

  const rows = useMemo(() => {
    const known = new Map<string, ThreadInfo>();
    for (const t of threads) {
      const title = threadTitles?.get(t.threadId);
      known.set(t.threadId, title && title !== t.title ? { ...t, title } : t);
    }
    const synthetic = new Set(openedThreads);
    for (const id of localKnown) synthetic.add(id);
    // A fresh chat can render before its store attachment effect runs.
    if (activeThreadId) synthetic.add(activeThreadId);
    for (const id of synthetic) {
      if (!known.has(id)) {
        known.set(id, {
          threadId: id,
          title: threadTitles?.get(id) ?? "New conversation",
          source: "user",
          pinned: false,
          unread: false,
          awaitingAction: false,
          createdAt: "",
          lastActivityAt: "",
        });
      }
    }
    return [...known.values()];
  }, [threads, openedThreads, localKnown, activeThreadId, threadTitles]);

  const isUnread = useCallback(
    (t: ThreadInfo) => t.unread && t.threadId !== activeThreadId,
    [activeThreadId],
  );

  const visibleRows =
    filter === "unread"
      ? rows.filter(isUnread)
      : filter === "action"
        ? rows.filter((t) => t.awaitingAction)
        : rows;

  const unreadCount = useMemo(() => rows.filter(isUnread).length, [rows, isUnread]);
  const actionCount = useMemo(
    () => rows.filter((t) => t.awaitingAction).length,
    [rows],
  );

  const groups = useMemo(() => {
    const pinned = visibleRows.filter((t) => t.pinned);
    const rest = visibleRows.filter((t) => !t.pinned);
    const byPeriod = new Map<string, ThreadInfo[]>();
    for (const t of rest) {
      const period: DatePeriod = t.lastActivityAt
        ? datePeriod(t.lastActivityAt)
        : "Today";
      const arr = byPeriod.get(period) ?? [];
      arr.push(t);
      byPeriod.set(period, arr);
    }
    const recency = (t: ThreadInfo) =>
      t.lastActivityAt ? Date.parse(t.lastActivityAt) : Infinity;
    const byRecency = (a: ThreadInfo, b: ThreadInfo) => recency(b) - recency(a);
    const out: { period: string; rows: ThreadInfo[] }[] = [];
    if (pinned.length > 0) out.push({ period: "Pinned", rows: pinned });
    for (const period of PERIOD_ORDER) {
      const arr = byPeriod.get(period);
      if (arr && arr.length > 0) out.push({ period, rows: [...arr].sort(byRecency) });
    }
    return out;
  }, [visibleRows]);

  const toggle = (period: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(period)) next.delete(period);
      else next.add(period);
      return next;
    });

  const searchActive = query.trim().length > 0;

  const openOrSelect = useCallback(
    (t: ThreadInfo) =>
      openedThreads.has(t.threadId) || t.threadId === activeThreadId
        ? onSelect(t.threadId)
        : onOpenThread(t.threadId),
    [openedThreads, activeThreadId, onSelect, onOpenThread],
  );

  const visibleOrder = useMemo<ThreadInfo[]>(() => {
    const out: ThreadInfo[] = [];
    for (const g of groups) if (!collapsed.has(g.period)) out.push(...g.rows);
    return out;
  }, [groups, collapsed]);

  const listNavigation = useSelectableListNavigation({
    itemIds: visibleOrder.map((thread) => thread.threadId),
    selectedId: activeThreadId,
    onSelect: (threadId) => {
      const target = visibleOrder.find((thread) => thread.threadId === threadId);
      if (target) openOrSelect(target);
    },
    ...(onFocusComposer ? { onActivate: () => onFocusComposer() } : {}),
    scrollElementRef: sidebarScrollRef,
  });
  const { scrollToItem, setListElement } = listNavigation;
  const setNavigableListElement = useCallback(
    (element: HTMLDivElement | null) => {
      setThreadListElement(element);
      setListElement(element);
    },
    [setListElement, setThreadListElement],
  );
  useThreadIndexHotkeys(
    useCallback(
      (index: number) => {
        const target = visibleOrder[index];
        if (!target) return;
        openOrSelect(target);
        scrollToItem(target.threadId);
      },
      [visibleOrder, openOrSelect, scrollToItem],
    ),
  );

  const onDeleteConfirm = useCallback(async () => {
    const t = confirmDelete;
    if (!t) return;
    const deletedIndex = visibleOrder.findIndex((row) => row.threadId === t.threadId);
    const replacement =
      t.threadId === activeThreadId
        ? selectionAfterDelete(visibleOrder, deletedIndex)
        : undefined;
    setConfirmDelete(null);
    try {
      await client.deleteThread(t.threadId);
      onDeleted(t.threadId);
      if (replacement) openOrSelect(replacement);
      await refresh();
      notify({ title: "Conversation deleted", tone: "success" });
    } catch (err) {
      console.error("delete failed", err);
      notify({
        title: "Could not delete conversation",
        description: err instanceof Error ? err.message : undefined,
        tone: "error",
      });
    }
  }, [
    confirmDelete,
    visibleOrder,
    activeThreadId,
    client,
    onDeleted,
    openOrSelect,
    notify,
    refresh,
  ]);
  const requestDeleteActive = useCallback(() => {
    if (!activeThreadId) return;
    const t = rows.find((r) => r.threadId === activeThreadId);
    if (t) setConfirmDelete(t);
  }, [activeThreadId, rows]);
  useHotkey("list.deleteConversation", requestDeleteActive);
  useHotkeyChord("Backspace", `zone:${SELECTABLE_LIST_ZONE}`, requestDeleteActive);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="new-chat" onClick={onNewChat}>
          <Plus size={16} /> New
        </button>
        <div className="sidebar-search-wrap">
          <Search size={16} className="sidebar-search-icon" />
          <input
            ref={listNavigation.searchInputRef}
            className="sidebar-search"
            placeholder="Search conversations..."
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {searching ? (
            <Loader2 size={15} className="sidebar-search-spin spin" />
          ) : query ? (
            <button
              className="sidebar-search-clear"
              aria-label="Clear search"
              onClick={() => onQueryChange("")}
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="sidebar-filter">
        <div className="segmented">
          <button
            className={`segmented-btn${filter === "all" ? " active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            className={`segmented-btn${filter === "unread" ? " active" : ""}`}
            onClick={() => setFilter("unread")}
          >
            Unread
            {unreadCount > 0 && <span className="segmented-count">{unreadCount}</span>}
          </button>
          <button
            className={`segmented-btn${filter === "action" ? " active" : ""}`}
            onClick={() => setFilter("action")}
          >
            Action
            {actionCount > 0 && <span className="segmented-count">{actionCount}</span>}
          </button>
        </div>
      </div>

      <div className="sidebar-scroll" ref={sidebarScrollRef}>
        {searchActive ? (
          hits.length === 0 ? (
            <div className="sidebar-empty">
              <div className="sidebar-empty-title">No results</div>
              <div className="sidebar-empty-sub">No conversations match “{query}”</div>
            </div>
          ) : (
            <ul className="search-hits" data-testid="search-hits">
              {hits.map((h, i) => (
                <li key={`${h.threadId}:${h.messageId}:${i}`}>
                  <button
                    className="hit"
                    onClick={() =>
                      onOpenSearchHit ? onOpenSearchHit(h) : onOpenThread(h.threadId)
                    }
                  >
                    <span className="hit-role">{h.role}</span>
                    <span className="hit-snippet">
                      {h.highlights.map((part, partIndex) =>
                        part.highlighted ? (
                          <mark key={partIndex}>{part.text}</mark>
                        ) : (
                          <span key={partIndex}>{part.text}</span>
                        ),
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : visibleRows.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-title">No conversations yet</div>
            <div className="sidebar-empty-sub">Create a new conversation to get started</div>
          </div>
        ) : (
          <div
            className="thread-groups"
            data-testid="thread-list"
            data-hotkey-zone={SELECTABLE_LIST_ZONE}
            ref={setNavigableListElement}
            tabIndex={0}
            role="listbox"
            aria-label="Conversations"
            aria-activedescendant={listNavigation.activeDescendant}
          >
            {groups.map(({ period, rows: groupRows }) => {
              const isCollapsed = collapsed.has(period);
              return (
                <div className="thread-group" key={period}>
                  <button className="thread-group-head" onClick={() => toggle(period)}>
                    <ChevronDown
                      size={12}
                      className={`thread-group-chevron${isCollapsed ? " collapsed" : ""}`}
                    />
                    <span className="thread-group-title">{period}</span>
                    <span className="thread-group-count">({groupRows.length})</span>
                  </button>
                  {!isCollapsed && (
                    <ul className="thread-list">
                      {groupRows.map((t) => {
                        const running = localRunning.includes(t.threadId);
                        const unread = isUnread(t);
                        const needsAction = t.awaitingAction;
                        return (
                          <li
                            key={t.threadId}
                            id={listNavigation.rowId(t.threadId)}
                            ref={(element) => listNavigation.setRowElement(t.threadId, element)}
                            role="option"
                            aria-selected={t.threadId === activeThreadId}
                            onClick={() => listNavigation.selectItem(t.threadId)}
                          >
                            {/* A div permits sibling pin/delete buttons without invalid button nesting. */}
                            <div
                              className={`thread-row${t.threadId === activeThreadId ? " active" : ""}${unread ? " unread" : ""}`}
                            >
                              <span className="thread-main">
                                <span className="thread-line1">
                                  {running && <Pen size={13} className="thread-running-icon" />}
                                  {unread && !running && (
                                    <span className="thread-unread-dot" aria-label="Unread" />
                                  )}
                                  <span className="thread-title">{t.title}</span>
                                  <span className="thread-time">
                                    {running ? "now" : relativeTime(t.lastActivityAt)}
                                  </span>
                                </span>
                                {t.lastMessage && (
                                  <span className="thread-preview">{t.lastMessage}</span>
                                )}
                              </span>
                              {needsAction && (
                                <span className="thread-action-pill" title="Awaiting your response">
                                  Action
                                </span>
                              )}
                              {t.source === "fork" && <span className="thread-badge">⑂</span>}
                              <span className="thread-actions">
                                <button
                                  className={`thread-action${t.pinned ? " pinned" : ""}`}
                                  aria-label={t.pinned ? "Unpin conversation" : "Pin conversation"}
                                  title={t.pinned ? "Unpin" : "Pin"}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void onPinToggle(t);
                                  }}
                                >
                                  {t.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                                </button>
                                <button
                                  className="thread-action danger"
                                  aria-label="Delete conversation"
                                  title="Delete"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDelete(t);
                                  }}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmationDialog
          title="Delete conversation?"
          message={`“${confirmDelete.title}” will be permanently deleted. This can’t be undone.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void onDeleteConfirm()}
        />
      )}
    </div>
  );
}
