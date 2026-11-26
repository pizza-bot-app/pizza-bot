import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "@pizza-bot/storage";
import type { Todo } from "@pizza-bot/core";
import { todoRoutes } from "./routes-todos.js";
import { TodoService } from "./todo-service.js";

const open: AppDatabase[] = [];

function testApp() {
  const appDb = openAppDatabase(":memory:");
  open.push(appDb);
  appDb.threadStore.create({ threadId: "th1", title: "Lunch plans" });
  appDb.threadStore.create({ threadId: "th2", title: "Invoice" });
  const todoService = new TodoService({
    todos: appDb.todos,
    threads: appDb.threadStore,
    triggers: appDb.triggers,
    scheduler: () => undefined,
    isRunning: () => false,
    automationsEnabled: () => true,
    agentStatus: (id) => (id === "researcher" ? { name: "Researcher", description: "Finds sources.", ready: true } : undefined),
    readyAgents: () => [],
    listGraphs: async () => [],
    awaitsInput: async () => false,
    postToThread: async () => {},
    timezone: "UTC",
  });
  return {
    routes: todoRoutes({ todoService, todoStore: appDb.todos, threadStore: appDb.threadStore }),
    appDb,
  };
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

afterEach(() => {
  for (const appDb of open.splice(0)) appDb.close();
});

describe("todoRoutes", () => {
  it("creates, reads, edits, completes, and deletes a Todo", async () => {
    const { routes } = testApp();
    const created = await routes.request("/todos", json("POST", { title: "  Renew passport  ", dueDate: "2026-12-01" }));
    expect(created.status).toBe(201);
    const todo = (await created.json()) as Todo;
    expect(todo).toMatchObject({ title: "Renew passport", dueDate: "2026-12-01", completed: false });

    expect(await (await routes.request(`/todos/${todo.id}`)).json()).toMatchObject({ id: todo.id });

    const patched = await routes.request(
      `/todos/${todo.id}`,
      json("PATCH", { importance: "high", dueDate: null, steps: [{ title: "Photos" }] }),
    );
    const edited = (await patched.json()) as Todo;
    expect(edited.importance).toBe("high");
    expect(edited.dueDate).toBeUndefined();
    expect(edited.steps).toEqual([{ id: expect.any(String), title: "Photos", completed: false }]);

    const done = (await (await routes.request(`/todos/${todo.id}`, json("PATCH", { completed: true }))).json()) as Todo;
    expect(done.completed).toBe(true);
    expect(done.completedAt).toEqual(expect.any(String));

    expect(await (await routes.request(`/todos/${todo.id}`, { method: "DELETE" })).json()).toEqual({ deleted: true });
    expect((await routes.request(`/todos/${todo.id}`)).status).toBe(404);
  });

  it("lists incomplete Todos before completed ones", async () => {
    const { routes, appDb } = testApp();
    const first = appDb.todos.create({ title: "first" });
    appDb.todos.create({ title: "second" });
    appDb.todos.update(first.id, { completed: true });
    const list = (await (await routes.request("/todos")).json()) as Todo[];
    expect(list.map((todo) => todo.completed)).toEqual([false, true]);
  });

  it("rejects invalid bodies", async () => {
    const { routes, appDb } = testApp();
    const todo = appDb.todos.create({ title: "a" });
    for (const body of [{ title: "" }, { title: "x", dueDate: "2026-02-30" }, { title: "x", importance: "urgent" }]) {
      expect((await routes.request("/todos", json("POST", body))).status).toBe(400);
    }
    expect((await routes.request("/todos", { method: "POST", body: "not json" })).status).toBe(400);
    const refused = await routes.request("/todos", json("POST", { title: "x", dueDate: "2026-02-30" }));
    expect(await refused.json()).toEqual({
      error: "invalid",
      detail: "dueDate: must be a calendar date (YYYY-MM-DD)",
    });
    expect((await routes.request(`/todos/${todo.id}`, json("PATCH", { title: "   " }))).status).toBe(400);
    expect((await routes.request("/todos/missing", json("PATCH", { title: "x" }))).status).toBe(404);
  });

  it("flags a thread into a Todo and refuses unknown threads", async () => {
    const { routes } = testApp();
    const flagged = await routes.request("/todos", json("POST", { title: "Lunch plans", threadIds: ["th1"] }));
    expect(((await flagged.json()) as Todo).threadIds).toEqual(["th1"]);
    expect((await routes.request("/todos", json("POST", { title: "x", threadIds: ["nope"] }))).status).toBe(400);
  });

  it("links and unlinks threads", async () => {
    const { routes, appDb } = testApp();
    const todo = appDb.todos.create({ title: "Pay invoice", threadIds: ["th1"] });
    const linked = await routes.request(`/todos/${todo.id}/threads/th2`, { method: "PUT" });
    expect(((await linked.json()) as Todo).threadIds).toEqual(["th1", "th2"]);
    expect((await routes.request(`/todos/${todo.id}/threads/nope`, { method: "PUT" })).status).toBe(404);
    expect((await routes.request("/todos/missing/threads/th1", { method: "PUT" })).status).toBe(404);

    const unlinked = await routes.request(`/todos/${todo.id}/threads/th1`, { method: "DELETE" });
    expect(((await unlinked.json()) as Todo).threadIds).toEqual(["th2"]);
    expect((await routes.request("/todos/missing/threads/th1", { method: "DELETE" })).status).toBe(404);
  });

  it("assigns, reschedules, and unassigns in the same PATCH as other edits", async () => {
    const { routes, appDb } = testApp();
    const todo = appDb.todos.create({ title: "Compare flights" });
    const assigned = (await (
      await routes.request(`/todos/${todo.id}`, json("PATCH", { owner: "researcher", importance: "high" }))
    ).json()) as Todo;
    expect(assigned).toMatchObject({ owner: "researcher", importance: "high", checkIn: { cron: "0 9 * * *" } });
    expect(assigned.history.map((event) => event.kind)).toEqual(["assigned"]);

    const manual = (await (await routes.request(`/todos/${todo.id}`, json("PATCH", { checkIn: null }))).json()) as Todo;
    expect(manual.owner).toBe("researcher");
    expect(manual.checkIn).toBeUndefined();

    const mine = (await (await routes.request(`/todos/${todo.id}`, json("PATCH", { owner: null }))).json()) as Todo;
    expect(mine.owner).toBeUndefined();
  });

  it("refuses an assignment it cannot honour with a sentence", async () => {
    const { routes, appDb } = testApp();
    const todo = appDb.todos.create({ title: "a" });
    const refused = await routes.request(`/todos/${todo.id}`, json("PATCH", { owner: "ghost", title: "renamed" }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid", detail: 'There is no enabled agent "ghost".' });
    expect(appDb.todos.get(todo.id)?.title).toBe("a");
  });

  it("answers a check-in it cannot start with 409 and the reason", async () => {
    const { routes, appDb } = testApp();
    const todo = appDb.todos.create({ title: "a" });
    const refused = await routes.request(`/todos/${todo.id}/check-in`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ detail: expect.stringContaining("Assign this Todo") });
  });
});

