import { describe, expect, it } from "vitest";
import type { Todo, TodoAccess, TodoCreateInput, TodoPatch } from "@pizza-bot/core";
import { todoTools } from "./todo-tools.js";

function memoryTodos(): TodoAccess & { all: Todo[] } {
  const all: Todo[] = [];
  let next = 0;
  return {
    all,
    list: ({ includeCompleted = true } = {}) => all.filter((todo) => includeCompleted || !todo.completed),
    get: (id) => all.find((todo) => todo.id === id),
    create(input: TodoCreateInput) {
      const todo: Todo = {
        id: `todo-${next++}`,
        title: input.title,
        notes: input.notes ?? "",
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        importance: input.importance ?? "normal",
        steps: (input.steps ?? []).map((step, i) => ({ id: `s${i}`, title: step.title, completed: false })),
        completed: false,
        threadIds: input.threadIds ?? [],
        history: [],
        notify: "immediate",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      all.push(todo);
      return todo;
    },
    update(id: string, patch: TodoPatch) {
      const todo = all.find((candidate) => candidate.id === id);
      if (!todo) return undefined;
      if (patch.title !== undefined) todo.title = patch.title;
      if (patch.completed !== undefined) todo.completed = patch.completed;
      if (patch.dueDate === null) delete todo.dueDate;
      else if (patch.dueDate !== undefined) todo.dueDate = patch.dueDate;
      return todo;
    },
    linkThread: () => undefined,
  };
}

function byName(todos: TodoAccess) {
  const [list_todos, create_todo, update_todo] = todoTools(todos);
  return { list_todos, create_todo, update_todo };
}

const inThread = { configurable: { thread_id: "th-1" } };

describe("todoTools", () => {
  it("creates a Todo linked to the calling conversation", async () => {
    const todos = memoryTodos();
    const tools = byName(todos);
    const result = JSON.parse(
      await tools.create_todo.invoke({ title: " Renew passport ", dueDate: "2026-12-01", steps: ["Photos"] }, inThread),
    );
    expect(result).toMatchObject({ title: "Renew passport", dueDate: "2026-12-01", linkedConversations: 1 });
    expect(todos.all[0]!.threadIds).toEqual(["th-1"]);
    expect(todos.all[0]!.steps.map((step) => step.title)).toEqual(["Photos"]);
  });

  it("skips the link when asked to", async () => {
    const todos = memoryTodos();
    await byName(todos).create_todo.invoke({ title: "Standalone", linkConversation: false }, inThread);
    expect(todos.all[0]!.threadIds).toEqual([]);
  });

  it("refuses an invalid due date with a message the model can act on", async () => {
    const tools = byName(memoryTodos());
    await expect(tools.create_todo.invoke({ title: "x", dueDate: "next friday" }, inThread)).rejects.toThrow(
      /dueDate/,
    );
  });

  it("lists incomplete Todos unless asked for completed ones", async () => {
    const todos = memoryTodos();
    const tools = byName(todos);
    todos.create({ title: "open" });
    const done = todos.create({ title: "done" });
    todos.update(done.id, { completed: true });
    expect(JSON.parse(await tools.list_todos.invoke({})).map((t: Todo) => t.title)).toEqual(["open"]);
    expect(JSON.parse(await tools.list_todos.invoke({ includeCompleted: true }))).toHaveLength(2);
  });

  it("updates a Todo and names a missing id", async () => {
    const todos = memoryTodos();
    const tools = byName(todos);
    const todo = todos.create({ title: "a", dueDate: "2026-01-02" });
    const updated = JSON.parse(await tools.update_todo.invoke({ id: todo.id, completed: true, dueDate: null }));
    expect(updated).toMatchObject({ completed: true });
    expect(updated.dueDate).toBeUndefined();
    await expect(tools.update_todo.invoke({ id: "missing", title: "x" })).rejects.toThrow(/list_todos/);
  });
});
