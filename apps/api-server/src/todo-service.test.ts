import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "@pizza-bot/storage";
import type { RunHandle, TriggerOccurrence } from "@pizza-bot/core";
import { TodoRefusal, TodoService, type AgentStatus } from "./todo-service.js";

const open: AppDatabase[] = [];

afterEach(() => {
  for (const appDb of open.splice(0)) appDb.close();
});

const AGENTS: Record<string, AgentStatus> = {
  researcher: { name: "Researcher", description: "Finds sources.", ready: true },
  booker: { name: "Booker", description: "Books travel.", ready: true },
  writer: { name: "Writer", description: "Drafts copy.", ready: true },
  broken: { name: "Broken", description: "Needs mail.", ready: false, detail: "mail is not configured" },
};

function harness(options: { automations?: boolean } = {}) {
  const appDb = openAppDatabase(":memory:");
  open.push(appDb);
  const running = new Set<string>();
  const posted: Array<[string, string]> = [];
  const fired: Array<[string, string]> = [];
  let threadCounter = 0;
  const service: TodoService = new TodoService({
    todos: appDb.todos,
    threads: appDb.threadStore,
    triggers: appDb.triggers,
    scheduler: () => ({
      reload: () => true,
      nextRunAt: (id) => (appDb.triggers.get(id)?.cron ? "2026-12-01T09:00:00.000Z" : undefined),
      runNow: (id, reason = "manual"): { handle: RunHandle } | undefined => {
        fired.push([id, reason]);
        const trigger = appDb.triggers.get(id)!;
        const resolved = service.resolveCheckIn(trigger, { reason } as TriggerOccurrence);
        if ("skip" in resolved) return undefined;
        return { handle: { runId: `run-${fired.length}`, threadId: resolved.threadId, status: "running", startedAt: 0 } };
      },
    }),
    isRunning: (threadId) => running.has(threadId),
    automationsEnabled: () => options.automations ?? true,
    agentStatus: (id) => AGENTS[id],
    readyAgents: () => Object.entries(AGENTS).filter(([, a]) => a.ready).map(([id, a]) => ({ id, ...a })),
    postToThread: async (threadId, text) => {
      posted.push([threadId, text]);
    },
    timezone: "UTC",
    newThreadId: () => `th-${threadCounter++}`,
  });
  return { service, appDb, running, posted, fired };
}

function occurrence(reason: TriggerOccurrence["reason"]): TriggerOccurrence {
  return { reason } as TriggerOccurrence;
}

describe("TodoService assignment", () => {
  it("assigns with the default morning check-in, changes it, and stops it", () => {
    const { service, appDb } = harness();
    const todo = service.create({ title: "Compare flights" });
    const assigned = service.assign(todo.id, { owner: "researcher" })!;
    expect(assigned.owner).toBe("researcher");
    expect(assigned.checkIn).toEqual({ cron: "0 9 * * *", timezone: "UTC", nextRunAt: "2026-12-01T09:00:00.000Z" });

    expect(service.assign(todo.id, { checkIn: "0 * * * *" })!.checkIn?.cron).toBe("0 * * * *");
    const manualOnly = service.assign(todo.id, { checkIn: null })!;
    expect(manualOnly.owner).toBe("researcher");
    expect(manualOnly.checkIn).toBeUndefined();
    expect(appDb.triggers.forTodo(todo.id)).toMatchObject({ enabled: true, todoId: todo.id });
    expect(appDb.triggers.forTodo(todo.id)?.cron).toBeUndefined();

    const unassigned = service.assign(todo.id, { owner: null })!;
    expect(unassigned.owner).toBeUndefined();
    expect(appDb.triggers.forTodo(todo.id)).toBeUndefined();
  });

  it("refuses an unknown or unready agent and an invalid schedule", () => {
    const { service } = harness();
    const todo = service.create({ title: "a" });
    expect(() => service.assign(todo.id, { owner: "ghost" })).toThrow(TodoRefusal);
    expect(() => service.assign(todo.id, { owner: "broken" })).toThrow("Broken is unavailable (mail is not configured).");
    expect(() => service.assign(todo.id, { owner: "researcher", checkIn: "every day" })).toThrow(/not a valid check-in schedule/);
    expect(service.get(todo.id)?.owner).toBeUndefined();
  });

  it("pauses the schedule while the Todo is complete", () => {
    const { service, appDb } = harness();
    const todo = service.create({ title: "a" });
    service.assign(todo.id, { owner: "researcher" });
    expect(service.update(todo.id, { completed: true })!.checkIn?.nextRunAt).toBeUndefined();
    expect(appDb.triggers.forTodo(todo.id)?.enabled).toBe(false);
    service.update(todo.id, { completed: false });
    expect(appDb.triggers.forTodo(todo.id)?.enabled).toBe(true);
  });

  it("deletes the schedule with the Todo", () => {
    const { service, appDb } = harness();
    const todo = service.create({ title: "a" });
    service.assign(todo.id, { owner: "researcher" });
    service.delete(todo.id);
    expect(appDb.triggers.forTodo(todo.id)).toBeUndefined();
  });
});

describe("TodoService check-ins", () => {
  it("runs a check-in in the owner's background thread and tells it about the Todo", () => {
    const { service, appDb } = harness();
    const todo = service.create({ title: "Compare flights", notes: "Under $400" });
    service.assign(todo.id, { owner: "researcher" });
    const trigger = appDb.triggers.forTodo(todo.id)!;

    const first = service.resolveCheckIn(trigger, occurrence("cron"));
    expect("threadId" in first && first.prompt).toContain("This is a scheduled check-in.");
    expect("threadId" in first && first.prompt).toContain('"title": "Compare flights"');
    expect("threadId" in first && first.prompt).toContain("- booker: Booker. Books travel.");
    expect("threadId" in first && first.prompt).not.toContain("- researcher:");
    const threadId = "threadId" in first ? first.threadId : "";
    expect(appDb.threadStore.get(threadId)).toMatchObject({
      background: true,
      agentId: "researcher",
      todoId: todo.id,
      title: "Compare flights",
    });
    const again = service.resolveCheckIn(trigger, occurrence("cron-recovery"));
    expect("threadId" in again && again.threadId).toBe(threadId);
    expect(service.get(todo.id)!.history.filter((e) => e.kind === "check-in").map((e) => e.reason)).toEqual(["cron", "cron"]);
  });

  it("skips a check-in while the last one runs or waits, and once the Todo is done", () => {
    const { service, appDb, running } = harness();
    const todo = service.create({ title: "a" });
    service.assign(todo.id, { owner: "researcher" });
    const trigger = appDb.triggers.forTodo(todo.id)!;
    const first = service.resolveCheckIn(trigger, occurrence("cron"));
    const threadId = "threadId" in first ? first.threadId : "";

    running.add(threadId);
    expect(service.resolveCheckIn(trigger, occurrence("cron"))).toEqual({ skip: "the previous check-in is still running" });
    running.delete(threadId);
    appDb.threadStore.update(threadId, { awaitingAction: true });
    expect(service.resolveCheckIn(trigger, occurrence("cron"))).toEqual({
      skip: "the previous check-in is waiting for your answer",
    });
    appDb.threadStore.update(threadId, { awaitingAction: false });
    service.update(todo.id, { completed: true });
    expect(service.resolveCheckIn(trigger, occurrence("cron"))).toEqual({ skip: "the Todo is complete" });
  });

  it("checks in on request, and explains why it cannot", () => {
    const { service } = harness();
    const todo = service.create({ title: "a" });
    expect(() => service.checkInNow(todo.id)).toThrow(/Assign this Todo/);
    service.assign(todo.id, { owner: "researcher", checkIn: null });
    expect(service.checkInNow(todo.id)).toMatchObject({ runId: "run-1" });
    expect(service.get(todo.id)!.history.at(-1)).toMatchObject({ kind: "check-in", reason: "manual" });

    const paused = harness({ automations: false });
    const other = paused.service.create({ title: "b" });
    paused.service.assign(other.id, { owner: "researcher" });
    expect(() => paused.service.checkInNow(other.id)).toThrow(/Automations is turned off/);
  });
});

function ownedTodo(h: ReturnType<typeof harness>, owner = "researcher") {
  const todo = h.service.create({ title: "Compare flights" });
  h.service.assign(todo.id, { owner });
  const resolved = h.service.resolveCheckIn(h.appDb.triggers.forTodo(todo.id)!, occurrence("cron"));
  return { todo, threadId: "threadId" in resolved ? resolved.threadId : "" };
}

describe("TodoService ambient access", () => {
  it("records progress and completion as the owner", () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    expect(h.service.todoForThread(threadId)?.id).toBe(todo.id);
    const done = h.service.recordProgress(threadId, { note: "Booked nothing yet; fares found.", completed: true });
    expect(done.completed).toBe(true);
    expect(done.history.slice(-2).map((e) => [e.kind, e.actor, e.note])).toEqual([
      ["progress", "researcher", "Booked nothing yet; fares found."],
      ["completed", "researcher", undefined],
    ]);
    expect(() => h.service.recordProgress("not-a-check-in", { note: "x" })).toThrow(/no longer owns a Todo/);
  });

  it("notifies in the agent's home thread, creating it once, and waits out a live conversation", async () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    await h.service.notifyUser(threadId, "Cheapest fare is Tuesday.");
    const home = h.appDb.threadStore.agentHome("researcher")!;
    expect(home).toMatchObject({ pinned: true, unread: true, lastMessage: "Cheapest fare is Tuesday.", title: "Researcher" });
    expect(h.posted).toEqual([[home.threadId, "Cheapest fare is Tuesday."]]);
    expect(h.service.get(todo.id)!.history.at(-1)).toMatchObject({ kind: "notified", threadId: home.threadId });

    h.running.add(home.threadId);
    await expect(h.service.notifyUser(threadId, "Again")).rejects.toThrow(/in a conversation with you/);
    expect(h.posted).toHaveLength(1);
  });

  it("records a failed check-in with its error", () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    h.service.recordFailure(threadId, "The security token included in the request is invalid.");
    h.service.recordFailure("not-a-check-in", "ignored");
    expect(h.service.get(todo.id)!.history.at(-1)).toMatchObject({
      kind: "failed",
      actor: "researcher",
      threadId,
      note: "The security token included in the request is invalid.",
    });
  });

  it("records a pause as a question to the user", () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    h.service.recordPause(threadId);
    expect(h.service.get(todo.id)!.history.at(-1)).toMatchObject({ kind: "asked", actor: "researcher", threadId });
  });
});

describe("TodoService handoffs", () => {
  it("hands off with the note, wakes the new owner, and retires the old thread", () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    const handed = h.service.reassign(threadId, "booker", "Book the Tuesday fare.");
    expect(handed.owner).toBe("booker");
    expect(h.fired.at(-1)).toEqual([`todo_${todo.id}`, "handoff"]);
    const after = h.service.get(todo.id)!;
    expect(after.backgroundThreadId).not.toBe(threadId);
    expect(h.appDb.threadStore.get(after.backgroundThreadId!)?.agentId).toBe("booker");
    expect(after.history.filter((e) => e.kind === "check-in").at(-1)).toMatchObject({ actor: "booker", reason: "handoff" });
    expect(() => h.service.recordProgress(threadId, { note: "late" })).toThrow(/no longer owns a Todo/);
  });

  it("puts the handoff note in the new owner's check-in", () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    h.service.reassign(threadId, "booker", "Book the Tuesday fare.");
    const prompt = h.service.resolveCheckIn(h.appDb.triggers.forTodo(todo.id)!, occurrence("handoff"));
    expect("prompt" in prompt && prompt.prompt).toContain("Researcher handed this Todo to you with this note: Book the Tuesday fare.");
  });

  it("refuses itself, unknown and unready agents, and handing back", () => {
    const h = harness();
    const { todo, threadId } = ownedTodo(h);
    expect(() => h.service.reassign(threadId, "researcher", "x")).toThrow("You already own this Todo.");
    expect(() => h.service.reassign(threadId, "ghost", "x")).toThrow(/You can hand off to: booker, writer/);
    expect(() => h.service.reassign(threadId, "broken", "x")).toThrow(/Broken is unavailable/);

    h.service.reassign(threadId, "booker", "over to you");
    const bookerThread = h.service.get(todo.id)!.backgroundThreadId!;
    expect(() => h.service.reassign(bookerThread, "researcher", "back to you")).toThrow(/already handed this Todo on/);
  });

  it("caps handoffs since the user last assigned the Todo", () => {
    const agents = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    for (const id of agents) AGENTS[id] = { name: id, description: id, ready: true };
    try {
      const h = harness();
      const { todo, threadId } = ownedTodo(h, "a1");
      let thread = threadId;
      for (const next of agents.slice(1, 6)) {
        h.service.reassign(thread, next, "next");
        thread = h.service.get(todo.id)!.backgroundThreadId!;
      }
      expect(() => h.service.reassign(thread, "a7", "next")).toThrow(/handed off 5 times/);
      h.service.assign(todo.id, { owner: "researcher" });
      const fresh = h.service.resolveCheckIn(h.appDb.triggers.forTodo(todo.id)!, occurrence("cron"));
      expect(() => h.service.reassign("threadId" in fresh ? fresh.threadId : "", "a7", "next")).not.toThrow();
    } finally {
      for (const id of agents) delete AGENTS[id];
    }
  });
});
