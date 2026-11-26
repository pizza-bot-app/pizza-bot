/** Pure Todo types and wire schemas: the user's to-do list, linked to inbox threads. */
import { z } from "zod";

export type TodoImportance = "normal" | "high";

export interface TodoStep {
  id: string;
  title: string;
  completed: boolean;
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

export type TodoCreateInput = z.infer<typeof todoCreateSchema>;
export type TodoPatch = z.infer<typeof todoPatchSchema>;
export type TodoStepInput = z.infer<typeof stepInput>;

/** The runtime's view of the Todo list; the orchestrator's Todo tools call only this. */
export interface TodoAccess {
  list(options?: { includeCompleted?: boolean }): Todo[];
  get(id: string): Todo | undefined;
  create(input: TodoCreateInput): Todo;
  update(id: string, patch: TodoPatch): Todo | undefined;
  linkThread(id: string, threadId: string): Todo | undefined;
}
