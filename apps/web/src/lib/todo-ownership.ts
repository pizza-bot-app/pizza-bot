/** Agent-owned Todos: check-in presets, timeline sentences, and threads waiting on the user. */
import type { Todo, TodoEvent } from "@pizza-bot/core";

export interface CheckInPreset {
  cron: string;
  label: string;
}

export const CHECK_IN_PRESETS: readonly CheckInPreset[] = [
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 9 * * *", label: "Every morning" },
  { cron: "0 9 * * 1-5", label: "Weekday mornings" },
  { cron: "0 9 * * 1", label: "Monday mornings" },
];

export const CHECK_IN_ON_REQUEST_LABEL = "Only when I ask";

/** The preset a schedule matches, `null` for no schedule, or `"custom"` for anything else. */
export function checkInChoice(cron: string | undefined): string | null | "custom" {
  if (cron === undefined) return null;
  const normalized = cron.trim().split(/\s+/).join(" ");
  return CHECK_IN_PRESETS.find((preset) => preset.cron === normalized)?.cron ?? "custom";
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: TodoEvent["kind"];
  text: string;
  threadId?: string;
  /** Set when `threadId` is that agent's work thread rather than a conversation. */
  workAgentId?: string;
}

const CHECK_IN_REASONS: Record<NonNullable<TodoEvent["reason"]>, string> = {
  cron: "scheduled",
  manual: "you asked",
  handoff: "handed off",
};

function sentence(event: TodoEvent, nameOf: (agentId: string) => string): string {
  const actor = event.actor === "user" ? "You" : nameOf(event.actor);
  const note = event.note?.trim();
  switch (event.kind) {
    case "assigned": {
      const to = event.agentId ? nameOf(event.agentId) : "someone";
      if (event.actor === "user") return `You assigned this to ${to}`;
      return note ? `${actor} handed this to ${to}: ${note}` : `${actor} handed this to ${to}`;
    }
    case "unassigned":
      return event.actor === "user" ? "You took this back" : `${actor} gave this back to you`;
    case "check-in":
      return event.reason ? `${actor} checked in (${CHECK_IN_REASONS[event.reason]})` : `${actor} checked in`;
    case "progress":
      return note ? `${actor} noted: ${note}` : `${actor} made progress`;
    case "completed":
      return note ? `${actor} completed this: ${note}` : `${actor} completed this`;
    case "reopened":
      return `${actor} reopened this`;
    case "notified":
      return `${actor} sent you an update`;
    case "asked":
      return `${actor} asked you a question`;
  }
}

const WORK_THREAD_KINDS = new Set<TodoEvent["kind"]>(["check-in", "asked"]);

/** The Todo's history as display sentences, newest first. */
export function todoTimeline(
  history: readonly TodoEvent[],
  nameOf: (agentId: string) => string,
): TimelineEntry[] {
  return [...history]
    .reverse()
    .map((event) => ({
      id: event.id,
      at: event.at,
      kind: event.kind,
      text: sentence(event, nameOf),
      ...(event.threadId ? { threadId: event.threadId } : {}),
      ...(event.threadId && event.actor !== "user" && WORK_THREAD_KINDS.has(event.kind)
        ? { workAgentId: event.actor }
        : {}),
    }));
}

/** Todos whose owner's work thread is paused on the user. */
export function todosAwaitingUser(
  todos: readonly Todo[],
  awaitingThreadIds: ReadonlySet<string>,
): Set<string> {
  const waiting = new Set<string>();
  for (const todo of todos) {
    if (todo.backgroundThreadId && awaitingThreadIds.has(todo.backgroundThreadId)) waiting.add(todo.id);
  }
  return waiting;
}

/** "in 40m", "in 5h", or a weekday and time beyond a day; empty when unknown or past. */
export function nextCheckInLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return "";
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.round(minutes / 60)}h`;
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
