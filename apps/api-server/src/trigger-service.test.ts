import { describe, it, expect, afterEach } from "vitest";
import type { RunHandle, RunInput, RunOptions } from "@pizza-bot/core";
import { openAppDatabase, type AppDatabase, type TriggerStore } from "@pizza-bot/storage";
import { TriggerService, type RunLauncher, type RunScopedEvent } from "./trigger-service.js";

function mockLauncher(prefix = "run") {
  const starts: Array<{ threadId: string; input: RunInput; opts: Partial<RunOptions> | undefined }> = [];
  const listeners = new Set<(evt: RunScopedEvent) => void>();
  let n = 0;
  const launcher: RunLauncher = {
    start(threadId, input, opts) {
      starts.push({ threadId, input, opts });
      return {
        runId: opts?.runId ?? `${prefix}_${n++}`,
        threadId,
        status: "running",
        startedAt: Date.now(),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    launcher,
    starts,
    emitRunEnd(handle: RunHandle, status: RunHandle["status"] = "success") {
      const scoped: RunScopedEvent = {
        runId: handle.runId,
        threadId: handle.threadId,
        event: { type: "run-end", runId: handle.runId, status },
      };
      for (const l of listeners) l(scoped);
    },
  };
}

const apps: AppDatabase[] = [];
function memStore(): TriggerStore {
  const app = openAppDatabase(":memory:");
  apps.push(app);
  return app.triggers;
}
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
});

describe("TriggerService: missed-run recovery", () => {
  it("does NOT fire a never-run cron trigger before its first tick after creation", () => {
    const store = memStore();
    const now = Date.parse("2026-07-05T12:30:00.000Z");
    store.create({
      id: "t",
      kind: "cron",
      enabled: true,
      cron: "0 0 1 1 *",
      createdAt: "2026-07-05T12:00:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(0);
    expect(store.occurrences("t")).toHaveLength(0);
    svc.stop();
  });

  it("fires once for a never-run cron trigger that missed a tick since creation", () => {
    const store = memStore();
    const now = Date.parse("2026-07-05T12:30:00.000Z");
    store.create({
      id: "t",
      kind: "cron",
      enabled: true,
      cron: "0 * * * *",
      createdAt: "2026-07-05T09:15:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(1);
    const [occurrence] = store.occurrences("t");
    expect(occurrence?.reason).toBe("cron-recovery");
    expect(occurrence?.scheduledAt).toBe("2026-07-05T10:00:00.000Z");
    svc.stop();
  });

  it("fires once when more than one interval has elapsed since lastRunAt", () => {
    const store = memStore();
    const now = Date.parse("2026-07-05T12:00:00.000Z");
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 * * * *",
      lastRunAt: "2026-07-05T09:00:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(1);
    svc.stop();
  });

  it("does NOT fire when less than one interval has elapsed", () => {
    const store = memStore();
    const now = Date.parse("2026-07-05T12:10:00.000Z");
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 * * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(0);
    svc.stop();
  });

  it("skips disabled triggers entirely", () => {
    const store = memStore();
    store.create({ id: "t", kind: "cron", enabled: false, cron: "0 * * * *" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(0);
    svc.stop();
  });

  it("pauses timers and recovers one missed occurrence after system sleep", () => {
    const store = memStore();
    let now = Date.parse("2026-07-05T12:10:00.000Z");
    store.create({
      id: "t",
      kind: "cron",
      enabled: true,
      cron: "0 * * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, {
      now: () => now,
      log: () => {},
    });
    svc.start();
    expect(m.starts).toHaveLength(0);

    svc.pauseForSystemSleep();
    expect(svc.isActive()).toBe(false);
    now = Date.parse("2026-07-05T15:10:00.000Z");
    expect(svc.recoverAfterSystemSleep()).toBe(true);
    expect(m.starts).toHaveLength(1);
    expect(store.occurrences("t")).toHaveLength(1);

    svc.recoverAfterSystemSleep();
    expect(m.starts).toHaveLength(1);
    expect(store.occurrences("t")).toHaveLength(1);
    svc.stop();
  });
});

describe("TriggerService: cron tick", () => {
  it("a cron tick starts a run and records it with the trigger's prompt", async () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 * * * *",
      prompt: "hourly digest",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    const now = Date.parse("2026-07-05T12:00:00.000Z");
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(0);

    await svc.cronJob("t")!.fireOnTick();
    expect(m.starts).toHaveLength(1);
    const input = m.starts[0]!.input;
    const text = "messages" in input ? (input.messages[0]!.parts[0] as { text: string }).text : "";
    expect(text).toBe("hourly digest");
    expect(m.starts[0]!.opts?.configurable?.source).toBe("trigger");
    expect(m.starts[0]!.opts?.configurable).not.toHaveProperty("agent");
    expect(store.occurrences("t")).toHaveLength(1);
    svc.stop();
  });
});

describe("TriggerService: runNow (manual)", () => {
  it("fires an enabled cron trigger on demand using its seed prompt", () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 9 * * *",
      prompt: "daily standup",
      lastRunAt: "2026-07-05T11:59:00.000Z",
    });
    const now = Date.parse("2026-07-05T12:00:00.000Z");
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(0);

    const result = svc.runNow("t");
    expect(result).toBeDefined();
    expect(m.starts).toHaveLength(1);
    const input = m.starts[0]!.input;
    const text = "messages" in input ? (input.messages[0]!.parts[0] as { text: string }).text : "";
    expect(text).toBe("daily standup");
    expect(store.occurrences("t")).toHaveLength(1);
    svc.stop();
  });

  it("updates the occurrence when the launched run ends", () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 9 * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, {
      now: () => Date.parse("2026-07-05T12:00:00.000Z"),
      log: () => {},
    });
    svc.start();
    const result = svc.runNow("t")!;
    const occurrenceId = m.starts[0]!.opts?.configurable?.trigger_occurrence_id as string;
    expect(store.getOccurrence(occurrenceId)).toMatchObject({ status: "running" });

    m.emitRunEnd(result.handle, "success");
    expect(store.getOccurrence(occurrenceId)).toMatchObject({
      status: "succeeded",
      runStatus: "success",
    });
    svc.stop();
  });

  it("durably links the occurrence before the launcher can execute", () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 9 * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    let observedBeforeLaunch = false;
    const launcher: RunLauncher = {
      start(threadId, _input, opts) {
        const occurrenceId = opts?.configurable?.trigger_occurrence_id as string;
        const occurrence = store.getOccurrence(occurrenceId);
        observedBeforeLaunch =
          occurrence?.status === "running" &&
          occurrence.threadId === threadId &&
          occurrence.runId === opts?.runId;
        return {
          runId: opts?.runId as string,
          threadId,
          status: "running",
          startedAt: Date.now(),
        };
      },
      subscribe: () => () => {},
    };
    const svc = new TriggerService(launcher, store, { log: () => {} });

    expect(svc.runNow("t")).toBeDefined();
    expect(observedBeforeLaunch).toBe(true);
    svc.stop();
  });

  it("marks the reserved occurrence failed when launch throws", () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 9 * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    const launcher: RunLauncher = {
      start() {
        throw new Error("launch failed");
      },
      subscribe: () => () => {},
    };
    const svc = new TriggerService(launcher, store, { log: () => {} });

    expect(() => svc.runNow("t")).toThrow("launch failed");
    const [occurrence] = store.occurrences("t");
    expect(occurrence).toMatchObject({
      status: "failed",
      runStatus: "error",
      lastError: "launch failed",
    });
    svc.stop();
  });

  it("returns undefined for a disabled trigger and starts nothing", () => {
    const store = memStore();
    store.create({ id: "t", kind: "cron", enabled: false, cron: "0 9 * * *" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {} });
    expect(svc.runNow("t")).toBeUndefined();
    expect(m.starts).toHaveLength(0);
    svc.stop();
  });

  it("returns undefined for an unknown trigger", () => {
    const store = memStore();
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {} });
    expect(svc.runNow("nope")).toBeUndefined();
    expect(m.starts).toHaveLength(0);
    svc.stop();
  });
});

describe("TriggerService: automations gate and recovery", () => {
  it("does not relaunch live occurrences when automations are toggled off and on", () => {
    const app = openAppDatabase(":memory:");
    apps.push(app);
    app.triggers.create({ id: "t", kind: "webhook", enabled: true, webhookSecret: "k", prompt: "triage" });
    app.settings.patch({ enableAutomations: true });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, app.triggers, {
      isEnabled: () => app.settings.get().enableAutomations,
      log: () => {},
    });
    svc.start();
    svc.invokeWebhook("t", { a: 1 });
    const occurrenceId = app.triggers.occurrences("t")[0]!.id;

    app.settings.patch({ enableAutomations: false });
    svc.reload();
    app.settings.patch({ enableAutomations: true });
    svc.reload();

    expect(m.starts).toHaveLength(1);
    expect(app.triggers.getOccurrence(occurrenceId)).toMatchObject({ status: "running", attempt: 1 });
    svc.stop();
  });

  it("recovers orphans once automations are first enabled after starting disabled", () => {
    const app = openAppDatabase(":memory:");
    apps.push(app);
    const at = new Date().toISOString();
    app.triggers.create({ id: "t", kind: "cron", prompt: "p", enabled: true, cron: "0 0 1 1 *", lastRunAt: at });
    app.triggers.createOccurrence({ id: "orphan", triggerId: "t", scheduledAt: at, reason: "manual", now: at });
    app.triggers.beginOccurrence("orphan", at, 3);
    app.triggers.attachRun("orphan", "thread_prev", "run_prev", "running", at);
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, app.triggers, {
      isEnabled: () => app.settings.get().enableAutomations,
      log: () => {},
    });
    svc.start();
    expect(m.starts).toHaveLength(0);

    app.settings.patch({ enableAutomations: true });
    svc.reload();
    expect(m.starts).toHaveLength(1);
    expect(app.triggers.getOccurrence("orphan")).toMatchObject({ attempt: 2 });
    svc.stop();
  });

  it("does not run persisted schedules while disabled and restores them when enabled", async () => {
    const app = openAppDatabase(":memory:");
    apps.push(app);
    app.triggers.create({
      id: "t",
      kind: "cron",
      enabled: true,
      cron: "0 * * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    app.settings.patch({ enableAutomations: true });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, app.triggers, {
      now: () => Date.parse("2026-07-05T12:10:00.000Z"),
      isEnabled: () => app.settings.get().enableAutomations,
      log: () => {},
    });
    svc.start();
    const staleJob = svc.cronJob("t")!;

    app.settings.patch({ enableAutomations: false });
    await staleJob.fireOnTick();
    expect(m.starts).toHaveLength(0);

    expect(svc.reload()).toBe(false);
    expect(svc.isActive()).toBe(false);
    expect(svc.activeCronJobs()).toEqual([]);
    expect(app.triggers.get("t")).toMatchObject({ enabled: true });

    app.settings.patch({ enableAutomations: true });
    expect(svc.reload()).toBe(true);
    expect(svc.isActive()).toBe(true);
    expect(svc.activeCronJobs()).toEqual(["t"]);
    await svc.cronJob("t")!.fireOnTick();
    expect(m.starts).toHaveLength(1);
    svc.stop();
  });

  it("does not recover due schedules when it starts while automations are disabled", () => {
    const app = openAppDatabase(":memory:");
    apps.push(app);
    app.triggers.create({
      id: "t",
      kind: "cron",
      enabled: true,
      cron: "0 * * * *",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, app.triggers, {
      isEnabled: () => app.settings.get().enableAutomations,
      log: () => {},
    });

    svc.start();

    expect(m.starts).toHaveLength(0);
    expect(app.triggers.occurrences("t")).toHaveLength(0);
    expect(svc.isActive()).toBe(false);
    expect(svc.activeCronJobs()).toEqual([]);
    svc.stop();
  });

  it("replays a crash-orphaned occurrence once on startup without a second row", () => {
    const store = memStore();
    store.create({ id: "t", kind: "cron", enabled: true, cron: "0 * * * *" });
    const now = Date.parse("2026-07-05T12:10:00.000Z");
    // A prior process began this occurrence and crashed before completing it.
    store.createOccurrence({
      id: "orphan",
      triggerId: "t",
      scheduledAt: new Date(now).toISOString(),
      reason: "manual",
      now: new Date(now).toISOString(),
    });
    store.beginOccurrence("orphan", new Date(now).toISOString(), 3);
    store.attachRun("orphan", "thread_prev", "run_prev", "running", new Date(now).toISOString());

    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();

    expect(m.starts).toHaveLength(1);
    expect(store.getOccurrence("orphan")).toMatchObject({ status: "running", attempt: 2 });
    expect(store.occurrences("t")).toHaveLength(1);
    svc.stop();
  });

  it("keeps existing jobs active when a reload cannot build every schedule", () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 * * * *",
      lastRunAt: "2026-07-05T12:00:00.000Z",
    });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, {
      now: () => Date.parse("2026-07-05T12:10:00.000Z"),
      log: () => {},
    });
    svc.start();
    const original = svc.cronJob("t");
    store.update("t", { cron: "not a cron" });

    // An unbuildable schedule must not tear down the already-armed jobs.
    expect(svc.reload()).toBe(true);
    expect(svc.isActive()).toBe(true);
    expect(svc.cronJob("t")).toBe(original);
    svc.stop();
  });
});

describe("TriggerService: graph targets", () => {
  it("delivers a webhook body as graph input and selects the graph", () => {
    const store = memStore();
    store.create({ id: "hook", kind: "webhook", name: "Inbound", graphId: "triage", enabled: true, webhookSecret: "k" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {} });

    const result = svc.invokeWebhook("hook", { prompt: "not a prompt here", user: "ada" });

    expect(result).toBeDefined();
    expect(m.starts).toHaveLength(1);
    const { input, opts } = m.starts[0]!;
    expect(input).toEqual({
      graphInput: {
        trigger: expect.objectContaining({ id: "hook", name: "Inbound", reason: "webhook" }),
        body: { prompt: "not a prompt here", user: "ada" },
      },
    });
    expect(opts?.configurable).toMatchObject({ graph_id: "triage", source: "trigger" });
  });

  it("continues a crash-orphaned graph occurrence on its own thread", () => {
    const store = memStore();
    store.create({ id: "t", kind: "cron", graphId: "digest", enabled: true, cron: "0 * * * *" });
    const now = Date.parse("2026-07-05T12:10:00.000Z");
    store.createOccurrence({
      id: "orphan",
      triggerId: "t",
      scheduledAt: new Date(now).toISOString(),
      reason: "manual",
      now: new Date(now).toISOString(),
    });
    store.beginOccurrence("orphan", new Date(now).toISOString(), 3);
    store.attachRun("orphan", "thread_prev", "run_prev", "running", new Date(now).toISOString());

    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { now: () => now, log: () => {} });
    svc.start();

    expect(m.starts).toHaveLength(1);
    expect(m.starts[0]).toMatchObject({
      threadId: "thread_prev",
      input: { graphInput: { trigger: { id: "t" } }, continueFromCheckpoint: true },
    });
    expect(store.getOccurrence("orphan")).toMatchObject({ threadId: "thread_prev", attempt: 2 });
    svc.stop();
  });

  it("keeps a paused occurrence waiting when a resume fails without leaving the pause", async () => {
    const store = memStore();
    store.create({ id: "t", kind: "webhook", graphId: "g", enabled: true, webhookSecret: "k" });
    const m = mockLauncher();
    let paused = true;
    const svc = new TriggerService(m.launcher, store, { log: () => {}, awaitsInput: async () => paused });
    svc.start();
    const { handle } = svc.invokeWebhook("t", { a: 1 })!;
    const occurrenceId = store.occurrences("t")[0]!.id;

    m.emitRunEnd(handle, "interrupted");
    expect(store.getOccurrence(occurrenceId)?.status).toBe("waiting");

    const refused = { ...handle, runId: "run_refused" };
    m.emitRunEnd(refused, "error");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getOccurrence(occurrenceId)?.status).toBe("waiting");

    paused = false;
    m.emitRunEnd({ ...handle, runId: "run_resumed" }, "success");
    expect(store.getOccurrence(occurrenceId)?.status).toBe("succeeded");
    svc.stop();
  });

  function waitingOccurrence(store: TriggerStore, trigger: { graphId?: string; prompt?: string }) {
    store.create({ id: "t", kind: "webhook", enabled: true, webhookSecret: "k", ...trigger });
    const at = "2026-07-05T12:00:00.000Z";
    store.createOccurrence({ id: "occ", triggerId: "t", scheduledAt: at, reason: "webhook", now: at });
    store.beginOccurrence("occ", at, 3);
    store.attachRun("occ", "thread_paused", "run_first", "running", at);
    store.completeOccurrenceRun("run_first", "thread_paused", "interrupted", at);
    expect(store.getOccurrence("occ")?.status).toBe("waiting");
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("continues a graph occurrence whose resumed run a crash interrupted", async () => {
    const store = memStore();
    waitingOccurrence(store, { graphId: "g" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {}, awaitsInput: async () => false });
    svc.start();
    await settle();

    expect(m.starts).toHaveLength(1);
    expect(m.starts[0]).toMatchObject({ threadId: "thread_paused", input: { continueFromCheckpoint: true } });
    expect(store.getOccurrence("occ")).toMatchObject({ status: "running", attempt: 2 });
    m.emitRunEnd({ runId: m.starts[0]!.opts!.runId!, threadId: "thread_paused", status: "success", startedAt: 0 });
    expect(store.getOccurrence("occ")?.status).toBe("succeeded");
    svc.stop();
  });

  it("leaves a waiting occurrence to the resume this process is already running", async () => {
    const store = memStore();
    waitingOccurrence(store, { graphId: "g" });
    const m = mockLauncher();
    const launcher: RunLauncher = { ...m.launcher, isRunning: (threadId) => threadId === "thread_paused" };
    const svc = new TriggerService(launcher, store, { log: () => {}, awaitsInput: async () => false });
    svc.start();
    await settle();

    expect(m.starts).toHaveLength(0);
    expect(store.getOccurrence("occ")?.status).toBe("waiting");
    svc.stop();
  });

  it("leaves an occurrence waiting while its thread still awaits an answer", async () => {
    const store = memStore();
    waitingOccurrence(store, { graphId: "g" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {}, awaitsInput: async () => true });
    svc.start();
    await settle();

    expect(m.starts).toHaveLength(0);
    expect(store.getOccurrence("occ")?.status).toBe("waiting");
    svc.stop();
  });

  it("fails a conversation occurrence whose resumed run a crash interrupted instead of re-running its prompt", async () => {
    const store = memStore();
    waitingOccurrence(store, { prompt: "triage" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {}, awaitsInput: async () => false });
    svc.start();
    await settle();

    expect(m.starts).toHaveLength(0);
    expect(store.getOccurrence("occ")).toMatchObject({ status: "failed" });
    svc.stop();
  });
});

describe("TriggerService: Todo check-ins", () => {
  it("runs a check-in on the Todo's thread with its prompt, by reason", () => {
    const store = memStore();
    store.create({ id: "todo_t1", kind: "cron", enabled: true, todoId: "t1" });
    const m = mockLauncher();
    const seen: string[] = [];
    const svc = new TriggerService(m.launcher, store, {
      log: () => {},
      todoCheckIn: (trigger, occurrence) => {
        seen.push(`${trigger.todoId}:${occurrence.reason}`);
        return { threadId: "bg-1", prompt: "Check in on t1." };
      },
    });
    svc.start();
    expect(m.starts).toHaveLength(0);

    expect(svc.runNow("todo_t1", "handoff")?.handle.threadId).toBe("bg-1");
    expect(seen).toEqual(["t1:handoff"]);
    const start = m.starts[0]!;
    expect(start.threadId).toBe("bg-1");
    expect(JSON.stringify(start.input)).toContain("Check in on t1.");
    expect(start.opts?.configurable).toMatchObject({ todo_id: "t1", source: "trigger" });
    expect(store.occurrences("todo_t1")[0]).toMatchObject({ reason: "handoff", threadId: "bg-1" });
    svc.stop();
  });

  it("closes a skipped check-in with the reason and launches nothing", () => {
    const store = memStore();
    store.create({ id: "todo_t1", kind: "cron", enabled: true, todoId: "t1" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, {
      log: () => {},
      todoCheckIn: () => ({ skip: "the Todo is complete" }),
    });
    expect(svc.runNow("todo_t1")).toBeUndefined();
    expect(m.starts).toHaveLength(0);
    expect(store.occurrences("todo_t1")[0]).toMatchObject({ status: "dead", lastError: "the Todo is complete" });
  });

  it("arms ordinary schedules beside a Todo checked in on only when asked", () => {
    const store = memStore();
    store.create({ id: "todo_t1", kind: "cron", enabled: true, todoId: "t1" });
    store.create({ id: "hourly", kind: "cron", enabled: true, cron: "0 * * * *", lastRunAt: new Date().toISOString() });
    const svc = new TriggerService(mockLauncher().launcher, store, { log: () => {} });
    svc.start();
    expect(svc.activeCronJobs()).toEqual(["hourly"]);
    expect(svc.nextRunAt("hourly")).toEqual(expect.any(String));
    expect(svc.nextRunAt("todo_t1")).toBeUndefined();
    svc.stop();
  });
});

describe("TriggerService: Todo check-ins owned by a graph", () => {
  it("runs the graph with the Todo as input", () => {
    const store = memStore();
    store.create({ id: "todo_t1", kind: "cron", enabled: true, todoId: "t1" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, {
      log: () => {},
      todoCheckIn: () => ({ threadId: "run-1", graphId: "triage", input: { todo: { id: "t1" }, reason: "manual" } }),
    });
    svc.runNow("todo_t1");
    const start = m.starts[0]!;
    expect(start.threadId).toBe("run-1");
    expect(start.input).toMatchObject({ graphInput: { todo: { id: "t1" }, reason: "manual", trigger: { id: "todo_t1" } } });
    expect(start.opts?.configurable).toMatchObject({ graph_id: "triage", todo_id: "t1" });
  });

  it("closes a check-in a restart interrupted instead of replaying it", () => {
    const store = memStore();
    store.create({ id: "todo_t1", kind: "cron", enabled: true, todoId: "t1" });
    const at = new Date().toISOString();
    store.createOccurrence({ id: "occ", triggerId: "todo_t1", scheduledAt: at, reason: "manual", now: at });
    store.beginOccurrence("occ", at, 3);
    let resolved = 0;
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, {
      log: () => {},
      todoCheckIn: () => {
        resolved++;
        return { threadId: "bg", prompt: "x" };
      },
    });
    svc.start();
    expect(resolved).toBe(0);
    expect(m.starts).toHaveLength(0);
    expect(store.getOccurrence("occ")).toMatchObject({ status: "dead", lastError: "interrupted by a restart; the next check-in continues" });
    svc.stop();
  });
});
