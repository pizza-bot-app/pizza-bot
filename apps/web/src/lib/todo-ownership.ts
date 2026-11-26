/** Owned Todos: check-in and snooze presets, timeline sentences, and threads waiting on the user. */
import { TODO_GRAPH_OWNER_PREFIX, type Todo, type TodoEvent } from "@pizza-bot/core";

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

/** The owner value the assignment picker and PATCH use: an agent id or `graph:<id>`. */
export function ownerValue(todo: Pick<Todo, "owner" | "ownerGraph">): string | undefined {
  if (todo.ownerGraph) return `${TODO_GRAPH_OWNER_PREFIX}${todo.ownerGraph}`;
  return todo.owner;
}

/** The graph id in a `graph:<id>` owner or actor, if it is one. */
export function graphIdOf(id: string): string | undefined {
  return id.startsWith(TODO_GRAPH_OWNER_PREFIX) ? id.slice(TODO_GRAPH_OWNER_PREFIX.length) : undefined;
}

/** A work thread to open: an agent's background thread or a graph's run. */
export type WorkOwner = { agentId: string } | { graphId: string };

export function workOwnerOf(id: string): WorkOwner {
  const graphId = graphIdOf(id);
  return graphId ? { graphId } : { agentId: id };
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: TodoEvent["kind"];
  text: string;
  threadId?: string;
  /** Set when `threadId` is this owner's work thread rather than a conversation. */
  workOwner?: string;
  /** A subtask entry's child Todo. */
  todoId?: string;
}

const CHECK_IN_REASONS: Record<NonNullable<TodoEvent["reason"]>, string> = {
  cron: "scheduled",
  manual: "you asked",
  handoff: "handed off",
  subtask: "a subtask finished",
};

/** "Tue 9:00 AM" style, in the viewer's zone. */
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

/** A weekday and time within the coming week; a date as well beyond it, so "Tue" is never ambiguous. */
export function whenLabel(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const far = Math.abs(at - now) > SIX_DAYS_MS;
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    ...(far ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

const SNOOZE_NOTE = /^until (\S+?)(?:: ([\s\S]*))?$/;

function snoozeSentence(actor: string, note: string | undefined): string {
  const match = note ? SNOOZE_NOTE.exec(note) : null;
  if (!match) return `${actor} lifted the snooze`;
  const reason = match[2]?.trim();
  return `${actor} snoozed check-ins until ${whenLabel(match[1]!)}${reason ? ` — ${reason}` : ""}`;
}

function subtaskSentence(actor: string, event: TodoEvent, nameOf: (id: string) => string): string {
  const child = event.agentId ? nameOf(event.agentId) : "another agent";
  const note = event.note?.trim() ?? "";
  if (note.startsWith("finished:")) return `${child} finished: ${note.slice("finished:".length).trim()}`;
  const title = note.startsWith("requested:") ? note.slice("requested:".length).trim() : note;
  return title ? `${actor} asked ${child} to: ${title}` : `${actor} asked ${child} for help`;
}

function sentence(event: TodoEvent, nameOf: (agentId: string) => string): string {
  const actor = event.actor === "user" ? "You" : nameOf(event.actor);
  const note = event.note?.trim();
  switch (event.kind) {
    case "assigned": {
      const to = event.agentId
        ? graphIdOf(event.agentId)
          ? `the ${nameOf(event.agentId)} workflow`
          : nameOf(event.agentId)
        : "someone";
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
    case "failed": {
      const whose = event.actor === "user" ? "The" : `${actor}'s`;
      return note ? `${whose} check-in failed: ${note}` : `${whose} check-in failed`;
    }
    case "snoozed":
      return snoozeSentence(actor, note);
    case "subtask":
      return subtaskSentence(actor, event, nameOf);
    case "paused":
      return note ? `Check-ins paused: ${note}` : "Check-ins paused";
  }
}

const WORK_THREAD_KINDS = new Set<TodoEvent["kind"]>(["check-in", "asked", "failed"]);

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
        ? { workOwner: event.actor }
        : {}),
      ...(event.kind === "subtask" && event.todoId ? { todoId: event.todoId } : {}),
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

export interface SnoozePreset {
  label: string;
  until: string;
}

function at9(day: Date): Date {
  const next = new Date(day);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** Later today (+3h), tomorrow 9 am, and next Monday 9 am, in the viewer's zone. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const later = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
  return [
    { label: "Later today", until: later.toISOString() },
    { label: "Tomorrow, 9 am", until: at9(tomorrow).toISOString() },
    { label: "Next Monday, 9 am", until: at9(monday).toISOString() },
  ];
}

/** The snooze still in effect, or undefined once it has passed. */
export function activeSnooze(snoozedUntil: string | undefined, now = Date.now()): string | undefined {
  if (!snoozedUntil) return undefined;
  const until = Date.parse(snoozedUntil);
  return Number.isFinite(until) && until > now ? snoozedUntil : undefined;
}

/** A `datetime-local` value as an ISO instant, or undefined when blank or invalid. */
export function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** A budget field's text as a limit: blank clears it; anything else must be 1-1000. */
export function parseCheckInLimit(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const limit = Number(trimmed);
  return limit >= 1 && limit <= 1000 ? limit : undefined;
}

export interface KnownWorkThreads {
  agents: Array<{ threadId: string; agentId: string }>;
  graphs: Array<{ threadId: string; graphId: string }>;
}

const WORK_EVENT_KINDS = new Set<TodoEvent["kind"]>(["check-in", "asked", "failed"]);

/**
 * Every work thread the Todos name, current or from an earlier check-in, so one
 * opened from search or a link is still shown read-only.
 */
export function knownWorkThreads(todos: readonly Todo[]): KnownWorkThreads {
  const agents = new Map<string, string>();
  const graphs = new Map<string, string>();
  const note = (threadId: string, owner: string) => {
    const graphId = graphIdOf(owner);
    if (graphId) graphs.set(threadId, graphId);
    else if (owner !== "user") agents.set(threadId, owner);
  };
  for (const todo of todos) {
    for (const event of todo.history) {
      if (event.threadId && WORK_EVENT_KINDS.has(event.kind)) note(event.threadId, event.actor);
    }
    const owner = ownerValue(todo);
    if (todo.backgroundThreadId && owner) note(todo.backgroundThreadId, owner);
  }
  return {
    agents: [...agents].map(([threadId, agentId]) => ({ threadId, agentId })),
    graphs: [...graphs].map(([threadId, graphId]) => ({ threadId, graphId })),
  };
}

