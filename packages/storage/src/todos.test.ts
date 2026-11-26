import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "./app-db.js";
import { TodoStore } from "./todos.js";

const open: AppDatabase[] = [];

function store(clock?: () => string): TodoStore {
  const appDb = openAppDatabase(":memory:");
  open.push(appDb);
  return clock ? new TodoStore(appDb.db, clock) : appDb.todos;
}

function ticking(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
}

afterEach(() => {
  for (const appDb of open.splice(0)) appDb.close();
});

describe("TodoStore", () => {
  it("creates a plain to-do with defaults", () => {
    const todo = store().create({ title: "Buy flour" });
    expect(todo).toMatchObject({
      title: "Buy flour",
      notes: "",
      importance: "normal",
      steps: [],
      completed: false,
      threadIds: [],
    });
    expect(todo.dueDate).toBeUndefined();
    expect(todo.completedAt).toBeUndefined();
  });

  it("lists incomplete first, newest first within each group", () => {
    const s = store(ticking());
    const a = s.create({ title: "a" });
    const b = s.create({ title: "b" });
    const c = s.create({ title: "c" });
    s.update(c.id, { completed: true });
    expect(s.list().map((t) => t.title)).toEqual(["b", "a", "c"]);
    expect(s.list({ includeCompleted: false }).map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("stamps completedAt on completion, keeps it on later edits, and clears it on reopen", () => {
    const s = store(ticking());
    const todo = s.create({ title: "Ship it" });
    const done = s.update(todo.id, { completed: true })!;
    expect(done.completedAt).toBeDefined();
    expect(s.update(todo.id, { notes: "shipped" })!.completedAt).toBe(done.completedAt);
    const reopened = s.update(todo.id, { completed: false })!;
    expect(reopened.completed).toBe(false);
    expect(reopened.completedAt).toBeUndefined();
  });

  it("sets and clears the due date", () => {
    const s = store();
    const todo = s.create({ title: "Taxes", dueDate: "2026-04-15" });
    expect(todo.dueDate).toBe("2026-04-15");
    expect(s.update(todo.id, { importance: "high" })!.dueDate).toBe("2026-04-15");
    expect(s.update(todo.id, { dueDate: null })!.dueDate).toBeUndefined();
  });

  it("replaces steps, keeping the ids it repeats and minting the rest", () => {
    const s = store();
    const todo = s.create({ title: "Trip", steps: [{ title: "Book flight" }, { title: "Pack" }] });
    const [flight, pack] = todo.steps;
    const updated = s.update(todo.id, {
      steps: [
        { id: pack!.id, title: "Pack bags", completed: true },
        { id: "made-up", title: "Water plants" },
        { id: pack!.id, title: "Duplicate" },
      ],
    })!;
    expect(updated.steps[0]).toEqual({ id: pack!.id, title: "Pack bags", completed: true });
    expect(updated.steps[1]!.id).not.toBe("made-up");
    expect(updated.steps[2]!.id).not.toBe(pack!.id);
    expect(updated.steps.map((step) => step.id)).not.toContain(flight!.id);
  });

  it("links threads once, in link order, and unlinks them", () => {
    const s = store(ticking());
    const todo = s.create({ title: "Reply", threadIds: ["th1", "th1"] });
    expect(todo.threadIds).toEqual(["th1"]);
    s.linkThread(todo.id, "th2");
    s.linkThread(todo.id, "th1");
    expect(s.get(todo.id)!.threadIds).toEqual(["th1", "th2"]);
    expect(s.unlinkThread(todo.id, "th1")!.threadIds).toEqual(["th2"]);
    expect(s.linkThread("missing", "th1")).toBeUndefined();
  });

  it("forgets a deleted thread without deleting its Todos", () => {
    const s = store();
    const a = s.create({ title: "a", threadIds: ["gone", "kept"] });
    const b = s.create({ title: "b", threadIds: ["gone"] });
    s.forgetThread("gone");
    expect(s.get(a.id)!.threadIds).toEqual(["kept"]);
    expect(s.get(b.id)!.threadIds).toEqual([]);
  });

  it("deletes a Todo with its links", () => {
    const s = store();
    const todo = s.create({ title: "a", threadIds: ["th1"] });
    expect(s.delete(todo.id)).toBe(true);
    expect(s.get(todo.id)).toBeUndefined();
    expect(s.delete(todo.id)).toBe(false);
    expect(s.create({ title: "b", threadIds: ["th1"] }).threadIds).toEqual(["th1"]);
  });

  it("notifies subscribers on changes, not on no-op links", () => {
    const s = store();
    let changes = 0;
    const unsubscribe = s.subscribe(() => changes++);
    const todo = s.create({ title: "a" });
    s.update(todo.id, { title: "b" });
    s.linkThread(todo.id, "th1");
    s.linkThread(todo.id, "th1");
    s.unlinkThread(todo.id, "missing");
    s.forgetThread("missing");
    s.delete(todo.id);
    unsubscribe();
    s.create({ title: "c" });
    expect(changes).toBe(4);
  });

  it("returns undefined when updating a missing Todo", () => {
    expect(store().update("missing", { title: "x" })).toBeUndefined();
  });
});
