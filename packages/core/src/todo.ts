/** Pure Todo types and wire schemas: the user's to-do list, linked to inbox threads. */
import { z } from "zod";

export type TodoImportance = "normal" | "high";

export interface TodoStep {
  id: string;
  title: string;
  completed: boolean;
}

export type TodoEventKind =
  | "assigned"
  | "unassigned"
  | "check-in"
  | "progress"
  | "completed"
  | "reopened"
  | "notified"
  | "asked"
  | "failed";

export type TodoCheckInReason = "cron" | "manual" | "handoff";

/** One timeline entry. `actor` is "user" or the acting agent's id; an agent-acted `assigned` is a handoff. */
export interface TodoEvent {
  id: string;
  at: string;
  kind: TodoEventKind;
  actor: "user" | string;
  /** For `assigned`: the new owner. */
  agentId?: string;
  note?: string;
  threadId?: string;
  reason?: TodoCheckInReason;
}

export interface TodoCheckIn {
  cron: string;
  timezone: string;
  nextRunAt?: string;
}

export interface Todo {
  id: string;
  title: string;
  notes: string;
  /** A calendar date (`YYYY-MM-DD`) with no zone; "due today" is judged in the viewer's zone. */
  dueDate?: string;
  importance: TodoImportance;
  steps: TodoStep[];
  completed: boolean;
  completedAt?: string;
  /** Threads the Todo was flagged from or linked to, oldest link first. */
  threadIds: string[];
  /** The agent that owns it; absent for the user's own to-do. */
  owner?: string;
  /** The owner's check-in schedule; absent means check-ins only when asked or handed off. */
  checkIn?: TodoCheckIn;
  /** Where the current owner's check-ins run; hidden from the Inbox unless it awaits the user. */
  backgroundThreadId?: string;
  /** Oldest first. */
  history: TodoEvent[];
  createdAt: string;
  updatedAt: string;
}

export const TODO_TITLE_MAX = 200;
export const TODO_NOTES_MAX = 10_000;
export const TODO_STEPS_MAX = 100;
export const TODO_THREADS_MAX = 50;

const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in `YYYY-MM-DD` form (rejects `2026-02-30`). */
export function isTodoDueDate(value: string): boolean {
  if (!DUE_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const title = z.string().trim().min(1).max(TODO_TITLE_MAX);
const dueDate = z.string().refine(isTodoDueDate, "must be a calendar date (YYYY-MM-DD)");
const importance = z.enum(["normal", "high"]) satisfies z.ZodType<TodoImportance>;
const stepInput = z.object({
  id: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(TODO_TITLE_MAX),
  completed: z.boolean().optional(),
});
const steps = z.array(stepInput).max(TODO_STEPS_MAX);
const threadId = z.string().min(1).max(200);

export const todoCreateSchema = z.object({
  title,
  notes: z.string().max(TODO_NOTES_MAX).optional(),
  dueDate: dueDate.optional(),
  importance: importance.optional(),
  steps: steps.optional(),
  threadIds: z.array(threadId).max(TODO_THREADS_MAX).optional(),
});

/** `dueDate: null` clears it; `steps` replaces the whole list, keeping ids it repeats. */
export const todoPatchSchema = z.object({
  title: title.optional(),
  notes: z.string().max(TODO_NOTES_MAX).optional(),
  dueDate: dueDate.nullable().optional(),
  importance: importance.optional(),
  completed: z.boolean().optional(),
  steps: steps.optional(),
});

export const TODO_DEFAULT_CHECK_IN = "0 9 * * *";
export const TODO_NOTE_MAX = 2_000;
/** Agent-to-agent handoffs allowed since the user last assigned the Todo. */
export const TODO_MAX_HANDOFFS = 5;

/** The user's assignment edits; `checkIn: null` keeps the owner but stops scheduled check-ins. */
export const todoAssignmentSchema = z.object({
  owner: z.string().min(1).max(200).nullable().optional(),
  checkIn: z.string().trim().min(1).max(200).nullable().optional(),
});

export type TodoAssignment = z.infer<typeof todoAssignmentSchema>;

export type TodoCreateInput = z.infer<typeof todoCreateSchema>;
export type TodoPatch = z.infer<typeof todoPatchSchema>;
export type TodoStepInput = z.infer<typeof stepInput>;

/**
 * What an agent's background check-in may do to the Todo it owns. Every call names
 * the calling thread; the host refuses a thread that is not the Todo's current
 * background thread, so an agent that handed a Todo on can no longer change it.
 */
export interface AmbientTodoAccess {
  todoForThread(threadId: string): Todo | undefined;
  recordProgress(threadId: string, update: { note: string } & Pick<TodoPatch, "completed" | "steps">): Todo;
  notifyUser(threadId: string, message: string): Promise<void>;
  reassign(threadId: string, toAgentId: string, note: string): Todo;
}

/** The runtime's view of the Todo list; the orchestrator's Todo tools call only this. */
export interface TodoAccess {
  list(options?: { includeCompleted?: boolean }): Todo[];
  get(id: string): Todo | undefined;
  create(input: TodoCreateInput): Todo;
  update(id: string, patch: TodoPatch): Todo | undefined;
  linkThread(id: string, threadId: string): Todo | undefined;
}
