/** The root agent's tools over the user's Todo list; subagents never receive them. */
import { tool, type ToolRunnableConfig } from "@langchain/core/tools";
import { z } from "zod";
import {
  todoCreateSchema,
  todoPatchSchema,
  TODO_STEPS_MAX,
  type Todo,
  type TodoAccess,
} from "@pizza-bot/core";

const LIST_LIMIT = 50;
const NOTES_PREVIEW = 300;

const dueDate = z
  .string()
  .describe("Calendar date as YYYY-MM-DD in the user's local zone; use the current date from context.");

const listSchema = z.object({
  includeCompleted: z.boolean().optional().describe("Also return completed Todos. Defaults to false."),
  limit: z.number().int().min(1).max(LIST_LIMIT).optional().describe(`At most this many, newest first. Defaults to ${LIST_LIMIT}.`),
});

const createSchema = z.object({
  title: z.string().describe("Short imperative title, e.g. 'Renew passport'."),
  notes: z.string().optional(),
  dueDate: dueDate.optional(),
  importance: z.enum(["normal", "high"]).optional(),
  steps: z.array(z.string()).max(TODO_STEPS_MAX).optional().describe("Checklist step titles, in order."),
  linkConversation: z
    .boolean()
    .optional()
    .describe("Link this conversation to the Todo so the user can return to it. Defaults to true."),
});

const updateSchema = z.object({
  id: z.string().describe("The Todo id from list_todos or create_todo."),
  title: z.string().optional(),
  notes: z.string().optional().describe("Replaces the notes."),
  dueDate: dueDate.nullable().optional().describe("YYYY-MM-DD, or null to clear the due date."),
  importance: z.enum(["normal", "high"]).optional(),
  completed: z.boolean().optional(),
  steps: z
    .array(z.object({ id: z.string().optional(), title: z.string(), completed: z.boolean().optional() }))
    .max(TODO_STEPS_MAX)
    .optional()
    .describe("Replaces the whole checklist. Repeat a step's id to keep it; omit id for a new step."),
});

function threadIdOf(config: ToolRunnableConfig | undefined): string | undefined {
  const threadId = (config?.configurable as { thread_id?: unknown } | undefined)?.thread_id;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}

function view(todo: Todo): Record<string, unknown> {
  return {
    id: todo.id,
    title: todo.title,
    ...(todo.notes
      ? { notes: todo.notes.length > NOTES_PREVIEW ? `${todo.notes.slice(0, NOTES_PREVIEW)}…` : todo.notes }
      : {}),
    ...(todo.dueDate ? { dueDate: todo.dueDate } : {}),
    importance: todo.importance,
    completed: todo.completed,
    steps: todo.steps,
    linkedConversations: todo.threadIds.length,
  };
}

function invalid(error: z.ZodError): Error {
  return new Error(
    `Invalid Todo: ${error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`,
  );
}

export function todoTools(todos: TodoAccess) {
  const listTodos = tool(
    (input: z.infer<typeof listSchema>) => {
      const all = todos.list({ includeCompleted: input.includeCompleted ?? false });
      const shown = all.slice(0, input.limit ?? LIST_LIMIT).map(view);
      return JSON.stringify(all.length > shown.length ? { todos: shown, omitted: all.length - shown.length } : shown);
    },
    {
      name: "list_todos",
      description:
        "List the user's Todos (their to-do list), incomplete ones by default. " +
        "Use it when the user asks about their Todos or to find a Todo's id before updating it.",
      schema: listSchema,
    },
  );

  const createTodo = tool(
    (input: z.infer<typeof createSchema>, config?: ToolRunnableConfig) => {
      const threadId = input.linkConversation === false ? undefined : threadIdOf(config);
      const parsed = todoCreateSchema.safeParse({
        title: input.title,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.steps ? { steps: input.steps.map((title) => ({ title })) } : {}),
        ...(threadId ? { threadIds: [threadId] } : {}),
      });
      if (!parsed.success) throw invalid(parsed.error);
      return JSON.stringify(view(todos.create(parsed.data)));
    },
    {
      name: "create_todo",
      description:
        "Add a Todo to the user's to-do list. Only call this when the user asks you to " +
        "add, track, or remind them of something; never create Todos on your own initiative.",
      schema: createSchema,
    },
  );

  const updateTodo = tool(
    (input: z.infer<typeof updateSchema>) => {
      const { id, ...patch } = input;
      const parsed = todoPatchSchema.safeParse(patch);
      if (!parsed.success) throw invalid(parsed.error);
      const updated = todos.update(id, parsed.data);
      if (!updated) throw new Error(`No Todo has id ${JSON.stringify(id)}; call list_todos for current ids.`);
      return JSON.stringify(view(updated));
    },
    {
      name: "update_todo",
      description:
        "Edit one of the user's Todos: rename it, change notes, due date, importance, or " +
        "steps, or mark it complete or incomplete. Only when the user asks for the change.",
      schema: updateSchema,
    },
  );

  return [listTodos, createTodo, updateTodo] as const;
}
