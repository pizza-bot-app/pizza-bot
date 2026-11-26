/** Todo smart views: pure predicates and ordering over calendar dates in the viewer's zone. */
import { isTodoDueDate, type Todo } from "@pizza-bot/core";

export type TodoView = "today" | "planned" | "important" | "all" | "completed";

export const TODO_VIEWS: readonly TodoView[] = ["today", "planned", "important", "all", "completed"];

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for `now` in the local zone, the same form as `Todo.dueDate`. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function isOverdue(todo: Todo, today: string): boolean {
  return !todo.completed && todo.dueDate !== undefined && todo.dueDate < today;
}

export function inTodoView(todo: Todo, view: TodoView, today: string): boolean {
  if (view === "completed") return todo.completed;
  if (todo.completed) return false;
  switch (view) {
    case "today":
      return todo.dueDate !== undefined && todo.dueDate <= today;
    case "planned":
      return todo.dueDate !== undefined;
    case "important":
      return todo.importance === "high";
    case "all":
      return true;
  }
}

const newestFirst = (a: Todo, b: Todo) => b.createdAt.localeCompare(a.createdAt);

function byDueDate(a: Todo, b: Todo): number {
  const due = (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
  if (due !== 0) return due;
  if (a.importance !== b.importance) return a.importance === "high" ? -1 : 1;
  return newestFirst(a, b);
}

function recentlyCompleted(a: Todo, b: Todo): number {
  return (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt);
}

export function todosInView(todos: readonly Todo[], view: TodoView, today: string): Todo[] {
  const rows = todos.filter((todo) => inTodoView(todo, view, today));
  const order =
    view === "completed" ? recentlyCompleted : view === "today" || view === "planned" ? byDueDate : newestFirst;
  return rows.sort(order);
}

export function todoViewCounts(todos: readonly Todo[], today: string): Record<TodoView, number> {
  const counts: Record<TodoView, number> = { today: 0, planned: 0, important: 0, all: 0, completed: 0 };
  for (const todo of todos) {
    for (const view of TODO_VIEWS) if (inTodoView(todo, view, today)) counts[view] += 1;
  }
  return counts;
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!) / DAY_MS;
}

export function dueLabel(dueDate: string, today: string): string {
  const offset = dayNumber(dueDate) - dayNumber(today);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  const [year, month, day] = dueDate.split("-").map(Number);
  const sameYear = dueDate.slice(0, 4) === today.slice(0, 4);
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function stepProgress(todo: Todo): { done: number; total: number } | undefined {
  if (todo.steps.length === 0) return undefined;
  return { done: todo.steps.filter((step) => step.completed).length, total: todo.steps.length };
}

/** Threads linked to at least one incomplete Todo: the Inbox's flag badge. */
export function flaggedThreadIds(todos: readonly Todo[]): Set<string> {
  const flagged = new Set<string>();
  for (const todo of todos) {
    if (!todo.completed) for (const threadId of todo.threadIds) flagged.add(threadId);
  }
  return flagged;
}

export function openTodoForThread(todos: readonly Todo[], threadId: string): Todo | undefined {
  return todos.find((todo) => !todo.completed && todo.threadIds.includes(threadId));
}

export const DUE_DATE_MIN = "1900-01-01";
export const DUE_DATE_MAX = "2999-12-31";

/**
 * What saving a typed due date does: a date to store, `null` to clear it, or
 * nothing. A partial or out-of-range entry reverts to the stored date.
 */
export function dueDateCommit(draft: string, current: string | undefined): string | null | "unchanged" | "revert" {
  if (draft === (current ?? "")) return "unchanged";
  if (!draft) return null;
  if (!isTodoDueDate(draft) || draft < DUE_DATE_MIN || draft > DUE_DATE_MAX) return "revert";
  return draft;
}

/** Milliseconds until the next local midnight, when "today" changes. */
export function msUntilLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

