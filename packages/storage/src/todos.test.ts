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

  describe("ownership and timeline", () => {
    it("records assignment, handoff, and unassignment, and resets the background thread", () => {
      const s = store(ticking());
      const todo = s.create({ title: "Research flights" });
      expect(todo.history).toEqual([]);

      s.setOwner(todo.id, "researcher", { actor: "user" });
      s.setBackgroundThread(todo.id, "bg-1");
      expect(s.forBackgroundThread("bg-1")?.id).toBe(todo.id);

      const handed = s.setOwner(todo.id, "booker", { actor: "researcher", note: "Found options; book one." })!;
      expect(handed.owner).toBe("booker");
      expect(handed.backgroundThreadId).toBeUndefined();
      expect(s.forBackgroundThread("bg-1")).toBeUndefined();

      const cleared = s.setOwner(todo.id, null, { actor: "user" })!;
      expect(cleared.owner).toBeUndefined();
      expect(cleared.history.map((event) => [event.kind, event.actor, event.agentId, event.note])).toEqual([
        ["assigned", "user", "researcher", undefined],
        ["assigned", "researcher", "booker", "Found options; book one."],
        ["unassigned", "user", undefined, undefined],
      ]);
    });

    it("does not record an assignment to the current owner", () => {
      const s = store();
      const todo = s.create({ title: "a" });
      s.setOwner(todo.id, "researcher", { actor: "user" });
      expect(s.setOwner(todo.id, "researcher", { actor: "user" })!.history).toHaveLength(1);
      expect(s.setOwner("missing", "researcher", { actor: "user" })).toBeUndefined();
    });

    it("records completion and reopening with their actor", () => {
      const s = store(ticking());
      const todo = s.create({ title: "a" });
      s.update(todo.id, { completed: true }, "researcher");
      s.update(todo.id, { notes: "x" }, "researcher");
      const reopened = s.update(todo.id, { completed: false })!;
      expect(reopened.history.map((event) => [event.kind, event.actor])).toEqual([
        ["completed", "researcher"],
        ["reopened", "user"],
      ]);
    });

    it("appends events and deletes them with the Todo", () => {
      const s = store(ticking());
      const todo = s.create({ title: "a" });
      const event = s.appendEvent(todo.id, { kind: "check-in", actor: "researcher", threadId: "bg", reason: "cron" });
      expect(event).toMatchObject({ kind: "check-in", threadId: "bg", reason: "cron" });
      expect(s.get(todo.id)!.history).toEqual([event]);
      expect(s.appendEvent("missing", { kind: "progress", actor: "user" })).toBeUndefined();
      s.delete(todo.id);
      const again = s.create({ title: "b" });
      expect(again.history).toEqual([]);
    });
  });

  describe("refinements", () => {
    it("stores a graph owner apart from an agent owner", () => {
      const s = store();
      const todo = s.create({ title: "Triage" });
      const graphOwned = s.setOwner(todo.id, "graph:triage", { actor: "researcher", note: "Routine" })!;
      expect(graphOwned.ownerGraph).toBe("triage");
      expect(graphOwned.owner).toBeUndefined();
      expect(graphOwned.history.at(-1)).toMatchObject({ kind: "assigned", agentId: "graph:triage" });
      expect(s.setOwner(todo.id, "graph:triage", { actor: "user" })!.history).toHaveLength(1);
    });

    it("snoozes and lifts the snooze on the timeline, and a new owner starts unsnoozed", () => {
      const s = store(ticking());
      const todo = s.create({ title: "a" });
      s.setOwner(todo.id, "researcher", { actor: "user" });
      const snoozed = s.setSnooze(todo.id, "2026-12-01T09:00:00.000Z", { actor: "researcher", note: "Fares update Monday" })!;
      expect(snoozed.snoozedUntil).toBe("2026-12-01T09:00:00.000Z");
      expect(snoozed.history.at(-1)).toMatchObject({
        kind: "snoozed",
        note: "until 2026-12-01T09:00:00.000Z: Fares update Monday",
      });
      expect(s.setSnooze(todo.id, null, { actor: "user" })!.snoozedUntil).toBeUndefined();
      s.setSnooze(todo.id, "2026-12-01T09:00:00.000Z", { actor: "user" });
      expect(s.setOwner(todo.id, "booker", { actor: "researcher" })!.snoozedUntil).toBeUndefined();
    });

    it("counts budgeted check-ins since the user last assigned it", () => {
      const s = store(ticking());
      const todo = s.create({ title: "a" });
      expect(s.get(todo.id)!.notify).toBe("immediate");
      s.setOwner(todo.id, "researcher", { actor: "user" });
      s.setPreferences(todo.id, { maxCheckIns: 3, notify: "digest" });
      s.appendEvent(todo.id, { kind: "check-in", actor: "researcher", reason: "cron" });
      s.appendEvent(todo.id, { kind: "check-in", actor: "researcher", reason: "cron" });
      expect(s.get(todo.id)).toMatchObject({ notify: "digest", budget: { maxCheckIns: 3, used: 2 } });
      s.setOwner(todo.id, "booker", { actor: "user" });
      expect(s.get(todo.id)!.budget).toEqual({ maxCheckIns: 3, used: 0 });
      expect(s.setPreferences(todo.id, { maxCheckIns: null })!.budget).toBeUndefined();
    });

    it("lists children and orphans them when the parent is deleted", () => {
      const s = store(ticking());
      const parent = s.create({ title: "Plan trip" });
      const child = s.create({ title: "Book hotel" }, { parentTodoId: parent.id });
      expect(child.parentTodoId).toBe(parent.id);
      expect(s.children(parent.id).map((todo) => todo.id)).toEqual([child.id]);
      s.delete(parent.id);
      expect(s.get(child.id)!.parentTodoId).toBeUndefined();
    });

    it("queues digest entries by agent and hands each out once", () => {
      const s = store(ticking());
      const a = s.create({ title: "a" });
      s.enqueueDigest("researcher", a.id, "first");
      s.enqueueDigest("booker", a.id, "other");
      s.enqueueDigest("researcher", a.id, "second");
      const taken = s.takeDigests();
      expect(taken.get("researcher")!.map((entry) => entry.message)).toEqual(["first", "second"]);
      expect(taken.get("booker")).toHaveLength(1);
      expect(s.takeDigests().size).toBe(0);
    });
  });
});

