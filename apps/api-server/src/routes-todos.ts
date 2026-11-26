import { Hono } from "hono";
import { todoCreateSchema, todoPatchSchema } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

export function todoRoutes(host: Pick<AgentHost, "todoStore" | "threadStore">): Hono {
  const app = new Hono();
  const todos = host.todoStore;

  app.get("/todos", (c) => c.json(todos.list()));

  app.post("/todos", async (c) => {
    const parsed = todoCreateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid", detail: parsed.error.message }, 400);
    const unknown = parsed.data.threadIds?.find((id) => !host.threadStore.get(id));
    if (unknown !== undefined) {
      return c.json({ error: "invalid", detail: `thread ${JSON.stringify(unknown)} not found` }, 400);
    }
    return c.json(todos.create(parsed.data), 201);
  });

  app.get("/todos/:todo_id", (c) => {
    const todo = todos.get(c.req.param("todo_id"));
    return todo ? c.json(todo) : c.json({ error: "not_found" }, 404);
  });

  app.patch("/todos/:todo_id", async (c) => {
    const parsed = todoPatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid", detail: parsed.error.message }, 400);
    const todo = todos.update(c.req.param("todo_id"), parsed.data);
    return todo ? c.json(todo) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/todos/:todo_id", (c) => c.json({ deleted: todos.delete(c.req.param("todo_id")) }));

  app.put("/todos/:todo_id/threads/:thread_id", (c) => {
    const threadId = c.req.param("thread_id");
    if (!host.threadStore.get(threadId)) return c.json({ error: "not_found", detail: "thread not found" }, 404);
    const todo = todos.linkThread(c.req.param("todo_id"), threadId);
    return todo ? c.json(todo) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/todos/:todo_id/threads/:thread_id", (c) => {
    const todo = todos.unlinkThread(c.req.param("todo_id"), c.req.param("thread_id"));
    return todo ? c.json(todo) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
