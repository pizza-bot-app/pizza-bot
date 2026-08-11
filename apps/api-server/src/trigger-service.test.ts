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
  it("fires once for a never-run cron trigger", () => {
    const store = memStore();
    store.create({ id: "t", kind: "cron", enabled: true, cron: "0 * * * *" });
    const m = mockLauncher();
    const svc = new TriggerService(m.launcher, store, { log: () => {} });
    svc.start();
    expect(m.starts).toHaveLength(1);
    expect(store.occurrences("t")).toHaveLength(1);
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
