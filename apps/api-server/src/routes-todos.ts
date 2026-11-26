import { Hono } from "hono";
import type { z } from "zod";
import { todoAssignmentSchema, todoCreateSchema, todoPatchSchema } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";
import { TodoRefusal } from "./todo-service.js";

const patchSchema = todoPatchSchema.extend(todoAssignmentSchema.shape);

export function todoRoutes(host: Pick<AgentHost, "todoService" | "todoStore" | "threadStore">): Hono {
  const app = new Hono();
  const todos = host.todoService;

  app.get("/todos", (c) => c.json(todos.list()));

  app.post("/todos", async (c) => {
    const parsed = todoCreateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid", detail: describe(parsed.error) }, 400);
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
    const id = c.req.param("todo_id");
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid", detail: describe(parsed.error) }, 400);
    const { owner, checkIn, ...patch } = parsed.data;
    if (!todos.get(id)) return c.json({ error: "not_found" }, 404);
    try {
      if (owner !== undefined || checkIn !== undefined) {
        todos.assign(id, {
          ...(owner !== undefined ? { owner } : {}),
          ...(checkIn !== undefined ? { checkIn } : {}),
        });
      }
    } catch (error) {
      if (error instanceof TodoRefusal) return c.json({ error: "invalid", detail: error.message }, 400);
      throw error;
    }
    const todo = Object.keys(patch).length > 0 ? todos.update(id, patch) : todos.get(id);
    return todo ? c.json(todo) : c.json({ error: "not_found" }, 404);
  });

  app.post("/todos/:todo_id/check-in", (c) => {
    try {
      return c.json(todos.checkInNow(c.req.param("todo_id")), 202);
    } catch (error) {
      if (error instanceof TodoRefusal) return c.json({ error: "conflict", detail: error.message }, 409);
      throw error;
    }
  });

  app.delete("/todos/:todo_id", (c) => c.json({ deleted: todos.delete(c.req.param("todo_id")) }));

  app.put("/todos/:todo_id/threads/:thread_id", (c) => {
    const threadId = c.req.param("thread_id");
    if (!host.threadStore.get(threadId)) return c.json({ error: "not_found", detail: "thread not found" }, 404);
    const todo = todos.linkThread(c.req.param("todo_id"), threadId);
    return todo ? c.json(todo) : c.json({ error: "not_found" }, 404);
  });

  app.delete("/todos/:todo_id/threads/:thread_id", (c) => {
    const id = c.req.param("todo_id");
    const todo = host.todoStore.unlinkThread(id, c.req.param("thread_id"));
    return todo ? c.json(todos.get(id)) : c.json({ error: "not_found" }, 404);
  });

  return app;
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "Request body"}: ${issue.message}`)
    .join("; ");
}
