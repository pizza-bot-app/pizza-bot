import { randomUUID } from "node:crypto";
import { CronJob, CronTime } from "cron";
import type {
  RunHandle,
  RunInput,
  RunOptions,
  RunStatus,
  TriggerDef,
  TriggerOccurrence,
  TriggerOccurrenceReason,
} from "@pizza-bot/core";
import type { TriggerStore } from "@pizza-bot/storage";
import type { Unsubscribe } from "./emitter.js";

export interface RunEndEvent {
  type: "run-end";
  runId: string;
  status: RunStatus;
}

export interface RunScopedEvent {
  runId: string;
  threadId: string;
  event: RunEndEvent;
}

export interface RunLauncher {
  start(threadId: string, input: RunInput, opts?: Partial<RunOptions>): RunHandle;
  subscribe(listener: (evt: RunScopedEvent) => void): Unsubscribe;
  isRunning?(threadId: string): boolean;
}

export interface TriggerServiceOptions {
  timezone?: string;
  now?: () => number;
  isEnabled?: () => boolean;
  /** Whether a thread is still paused for a person after a run on it ends. */
  awaitsInput?: (threadId: string) => Promise<boolean>;
  newThreadId?: () => string;
  maxAttempts?: number;
  log?: (msg: string) => void;
}

let threadCounter = 0;

/**
 * Single-process scheduler: the API server owns cron/webhook triggers, arms
 * their occurrences, and replays crash-orphaned work once on startup. There is
 * no cross-process lease — one owner is the design.
 */
export class TriggerService {
  private jobs = new Map<string, CronJob>();
  private unsubscribeEvents: (() => void) | undefined;
  private readonly tz: string;
  private readonly now: () => number;
  private readonly isEnabled: () => boolean;
  private readonly awaitsInput: ((threadId: string) => Promise<boolean>) | undefined;
  private readonly mintThreadId: () => string;
  private readonly maxAttempts: number;
  private readonly log: (msg: string) => void;
  private active = false;
  private recoveredOccurrences = false;
  private scheduleFingerprint = "";
  private lastInvocationMs = 0;

  constructor(
    private readonly launcher: RunLauncher,
    private readonly store: TriggerStore,
    opts: TriggerServiceOptions = {},
  ) {
    this.tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.now = opts.now ?? (() => Date.now());
    this.isEnabled = opts.isEnabled ?? (() => true);
    this.awaitsInput = opts.awaitsInput;
    this.mintThreadId =
      opts.newThreadId ?? (() => `thread_trigger_${Date.now().toString(36)}_${threadCounter++}`);
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.log = opts.log ?? ((message) => console.log(`[trigger-service] ${message}`));
  }

  start(): void {
    if (!this.unsubscribeEvents) this.subscribeEvents();
    this.evaluate();
  }

  /** Rebuild schedules after a trigger CRUD change or an automations toggle. */
  reload(): boolean {
    this.evaluate();
    return this.active;
  }

  pauseForSystemSleep(): void {
    this.disarm();
  }

  recoverAfterSystemSleep(): boolean {
    if (!this.isEnabled()) {
      this.disarm();
      return false;
    }
    if (!this.reconcileSchedules(true)) return false;
    this.active = true;
    for (const trigger of this.store.listEnabled("cron")) {
      this.recoverMissedRun(trigger);
    }
    this.log(`resumed: ${this.jobs.size} cron job(s)`);
    return true;
  }

  stop(): void {
    this.disarm();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
  }

  activeCronJobs(): string[] {
    return [...this.jobs.keys()];
  }

  cronJob(triggerId: string): CronJob | undefined {
    return this.jobs.get(triggerId);
  }

  isActive(): boolean {
    return this.active;
  }

  invokeWebhook(triggerId: string, body: unknown): { handle: RunHandle } | undefined {
    if (!this.isEnabled()) return undefined;
    const trigger = this.store.get(triggerId);
    if (!trigger || !trigger.enabled || trigger.kind !== "webhook") return undefined;
    let override: { promptOverride?: string; inputOverride?: unknown } = {};
    if (trigger.graphId) {
      if (body !== undefined) override = { inputOverride: body };
    } else {
      const prompt = webhookPrompt(body) ?? trigger.prompt;
      if (prompt !== undefined) override = { promptOverride: prompt };
    }
    const occurrence = this.createOccurrence(trigger.id, "webhook", override);
    const handle = this.launchOccurrence(occurrence.id);
    return handle ? { handle } : undefined;
  }

  runNow(triggerId: string): { handle: RunHandle } | undefined {
    if (!this.isEnabled()) return undefined;
    const trigger = this.store.get(triggerId);
    if (!trigger || !trigger.enabled) return undefined;
    const occurrence = this.createOccurrence(trigger.id, "manual");
    const handle = this.launchOccurrence(occurrence.id);
    return handle ? { handle } : undefined;
  }

  private evaluate(): void {
    if (!this.isEnabled()) {
      this.disarm();
      return;
    }
    const wasActive = this.active;
    if (!this.reconcileSchedules(true)) return;
    this.active = true;
    if (!wasActive) {
      // Only a previous process's runs can be orphaned; re-arming after an automations
      // toggle would otherwise relaunch this process's live runs as duplicates.
      if (!this.recoveredOccurrences) {
        this.recoveredOccurrences = true;
        this.recoverOccurrences();
      }
      for (const trigger of this.store.listEnabled("cron")) this.recoverMissedRun(trigger);
      this.log(`armed: ${this.jobs.size} cron job(s)`);
    }
  }

  private disarm(): void {
    for (const job of this.jobs.values()) void job.stop();
    this.jobs.clear();
    this.scheduleFingerprint = "";
    this.active = false;
  }

  private reconcileSchedules(force: boolean): boolean {
    const triggers = this.store.listEnabled("cron");
    const fingerprint = JSON.stringify(
      triggers.map((trigger) => [trigger.id, trigger.cron, trigger.timezone ?? this.tz]),
    );
    if (!force && fingerprint === this.scheduleFingerprint) return true;

    let nextJobs: Map<string, CronJob>;
    try {
      nextJobs = this.buildCronJobs(triggers);
    } catch (error) {
      this.log(`schedule reload rejected: ${errorMessage(error)}`);
      return false;
    }

    for (const job of this.jobs.values()) void job.stop();
    for (const job of nextJobs.values()) job.start();
    this.jobs = nextJobs;
    this.scheduleFingerprint = fingerprint;
    return true;
  }

  private buildCronJobs(triggers: TriggerDef[]): Map<string, CronJob> {
    const next = new Map<string, CronJob>();
    for (const trigger of triggers) {
      if (!trigger.cron) throw new Error(`cron trigger ${trigger.id} has no schedule`);
      const timezone = trigger.timezone ?? this.tz;
      const job = new CronJob(
        trigger.cron,
        () => {
          if (!this.isEnabled()) return;
          const scheduledAt = cronTickIso(this.now());
          const occurrence = this.createOccurrence(trigger.id, "cron", { scheduledAt });
          this.launchOccurrence(occurrence.id);
        },
        null,
        false,
        timezone,
        null,
        false,
        null,
        false,
        true,
        (error) => this.log(`cron ${trigger.id} failed: ${errorMessage(error)}`),
      );
      next.set(trigger.id, job);
    }
    return next;
  }

  private recoverMissedRun(trigger: TriggerDef): void {
    if (!trigger.cron) return;
    let scheduledAt: string | undefined;
    try {
      const timezone = trigger.timezone ?? this.tz;
      // A trigger that has never run can only have missed ticks since it was created.
      const next = new CronTime(trigger.cron, timezone).getNextDateFrom(
        new Date(trigger.lastRunAt ?? trigger.createdAt),
        timezone,
      );
      if (next.toMillis() <= this.now()) scheduledAt = next.toUTC().toISO() ?? undefined;
    } catch (error) {
      this.log(`missed-run check failed for ${trigger.id}: ${errorMessage(error)}`);
    }
    if (!scheduledAt) return;
    const occurrence = this.createOccurrence(trigger.id, "cron-recovery", { scheduledAt });
    this.launchOccurrence(occurrence.id);
  }

  private recoverOccurrences(): void {
    for (const occurrence of this.store.listRecoverableOccurrences()) {
      this.launchOccurrence(occurrence.id);
    }
    if (this.awaitsInput) {
      for (const occurrence of this.store.listWaitingOccurrences()) void this.recoverInterruptedResume(occurrence);
    }
  }

  // A crash during a resumed run leaves its occurrence `waiting` on a thread that
  // no longer awaits input; no later answer or run end would ever close it.
  private async recoverInterruptedResume(occurrence: TriggerOccurrence): Promise<void> {
    if (!occurrence.threadId) return;
    const paused = await this.awaitsInput!(occurrence.threadId).catch(() => true);
    // Recovery can run long after boot (automations enabled later), by which time
    // the thread may be running a resume this process started; that run closes it.
    if (paused || this.launcher.isRunning?.(occurrence.threadId)) return;
    const now = this.nowIso();
    if (!this.store.reopenWaitingOccurrence(occurrence.id, now)) return;
    if (!this.store.get(occurrence.triggerId)?.graphId) {
      // A conversation has no checkpoint to continue from; relaunching would re-run its prompt.
      this.store.failOccurrence(occurrence.id, "the server stopped during the resumed run", now);
      return;
    }
    try {
      this.launchOccurrence(occurrence.id);
    } catch (error) {
      this.log(`recovering occurrence ${occurrence.id} failed: ${errorMessage(error)}`);
    }
  }

  private subscribeEvents(): void {
    this.unsubscribeEvents = this.launcher.subscribe(({ runId, threadId, event }) => {
      if (event.type !== "run-end") return;
      const resumeFailed =
        event.status !== "success" &&
        event.status !== "interrupted" &&
        this.awaitsInput !== undefined &&
        this.store.findOccurrenceByRunId(runId) === undefined;
      if (!resumeFailed) {
        this.store.completeOccurrenceRun(runId, threadId, event.status, this.nowIso());
        return;
      }
      // A refused or cancelled resume leaves the pause in place, so the
      // occurrence keeps waiting for the next answer.
      void this.awaitsInput!(threadId)
        .catch(() => false)
        .then((paused) =>
          this.store.completeOccurrenceRun(runId, threadId, paused ? "interrupted" : event.status, this.nowIso()),
        );
    });
  }

  private createOccurrence(
    triggerId: string,
    reason: TriggerOccurrenceReason,
    options: { scheduledAt?: string; promptOverride?: string; inputOverride?: unknown } = {},
  ): TriggerOccurrence {
    const scheduledAt = options.scheduledAt ?? this.nextInvocationIso();
    const id = `tocc_${randomUUID()}`;
    return this.store.createOccurrence({
      id,
      triggerId,
      scheduledAt,
      reason,
      now: this.nowIso(),
      ...(options.promptOverride !== undefined ? { promptOverride: options.promptOverride } : {}),
      ...(options.inputOverride !== undefined ? { inputOverride: options.inputOverride } : {}),
    }).occurrence;
  }

  private launchOccurrence(occurrenceId: string): RunHandle | undefined {
    const now = this.nowIso();
    if (!this.isEnabled()) {
      this.store.killOccurrence(occurrenceId, "automations disabled", now);
      return undefined;
    }
    const begun = this.store.beginOccurrence(occurrenceId, now, this.maxAttempts);
    if (!begun) return undefined;

    const trigger = this.store.get(begun.triggerId);
    if (!trigger || !trigger.enabled) {
      this.store.killOccurrence(begun.id, "trigger missing or disabled", now);
      return undefined;
    }
    if (!this.isEnabled()) {
      this.store.killOccurrence(begun.id, "automations disabled", this.nowIso());
      return undefined;
    }

    // A recovered graph occurrence continues its own checkpoint rather than
    // re-running nodes (and their side effects) that already finished.
    const continuing = trigger.graphId !== undefined && begun.attempt > 1 && begun.threadId !== undefined;
    const threadId = continuing ? begun.threadId! : this.mintThreadId();
    const input: RunInput = trigger.graphId
      ? {
          graphInput: graphRunInput(trigger, begun),
          ...(continuing ? { continueFromCheckpoint: true } : {}),
        }
      : conversationInput(trigger, begun);

    try {
      // Reserve the run id and record it on the occurrence BEFORE launching, so a
      // crash can never leave an in-flight run with no occurrence row tracking it.
      const runId = `run_trigger_${randomUUID()}`;
      const running = this.store.attachRun(begun.id, threadId, runId, "running", this.nowIso());
      if (!running) {
        throw new Error(`lost occurrence before reserving run ${runId}`);
      }
      const handle = this.launcher.start(threadId, input, {
        runId,
        configurable: {
          thread_id: threadId,
          source: "trigger",
          trigger_id: trigger.id,
          trigger_occurrence_id: begun.id,
          ...(trigger.graphId ? { graph_id: trigger.graphId } : {}),
        },
      });
      if (handle.runId !== runId) {
        throw new Error(`launcher returned ${handle.runId} for reserved run ${runId}`);
      }
      this.log(`fired ${trigger.id} (${begun.reason}) -> thread ${threadId} run ${handle.runId}`);
      return handle;
    } catch (error) {
      this.store.failOccurrence(begun.id, errorMessage(error), this.nowIso());
      throw error;
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private nextInvocationIso(): string {
    const timestamp = Math.max(this.now(), this.lastInvocationMs + 1);
    this.lastInvocationMs = timestamp;
    return new Date(timestamp).toISOString();
  }
}

function conversationInput(trigger: TriggerDef, occurrence: TriggerOccurrence): RunInput {
  const kindWord = occurrence.reason === "webhook" ? "webhook" : "scheduled";
  const prompt =
    occurrence.promptOverride ??
    trigger.prompt ??
    `This ${kindWord} trigger (${trigger.id}) fired with no seed prompt configured and ` +
      `no prompt supplied in the request, so there is no task to perform. ` +
      `Reply with a single line noting that no task was provided.`;
  return {
    messages: [
      {
        id: `msg_${Date.now().toString(36)}`,
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ],
  };
}

/** The `input` state a graph run starts from; specs read it as `{{input.…}}`. */
function graphRunInput(trigger: TriggerDef, occurrence: TriggerOccurrence): Record<string, unknown> {
  return {
    trigger: {
      id: trigger.id,
      ...(trigger.name ? { name: trigger.name } : {}),
      reason: occurrence.reason,
      scheduledAt: occurrence.scheduledAt,
      occurrenceId: occurrence.id,
    },
    ...(trigger.prompt ? { prompt: trigger.prompt } : {}),
    ...(occurrence.inputOverride !== undefined ? { body: occurrence.inputOverride } : {}),
  };
}

function cronTickIso(now: number): string {
  return new Date(Math.floor(now / 1000) * 1000).toISOString();
}

function webhookPrompt(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const value = body as { prompt?: unknown; text?: unknown };
    if (typeof value.prompt === "string") return value.prompt;
    if (typeof value.text === "string") return value.text;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
