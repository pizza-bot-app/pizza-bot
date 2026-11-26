/** Owns Todo assignment: owners, check-in schedules, background threads, and the ambient tools' host side. */
import { CronTime } from "cron";
import {
  TODO_DEFAULT_CHECK_IN,
  TODO_MAX_HANDOFFS,
  type AmbientTodoAccess,
  type Todo,
  type TodoAccess,
  type TodoAssignment,
  type TodoCheckInReason,
  type TodoCreateInput,
  type TodoEvent,
  type TodoPatch,
  type TriggerDef,
  type TriggerOccurrence,
} from "@pizza-bot/core";
import type { StoredTodo, ThreadStore, TodoStore, TriggerStore } from "@pizza-bot/storage";
import type { TriggerService } from "./trigger-service.js";

export interface AgentStatus {
  name: string;
  description: string;
  ready: boolean;
  detail?: string;
}

export interface TodoServiceDeps {
  todos: TodoStore;
  threads: ThreadStore;
  triggers: TriggerStore;
  scheduler: () => Pick<TriggerService, "runNow" | "nextRunAt" | "reload"> | undefined;
  isRunning: (threadId: string) => boolean;
  automationsEnabled: () => boolean;
  /** Enabled agents only; absent means no such agent or it is disabled. */
  agentStatus: (agentId: string) => AgentStatus | undefined;
  readyAgents: () => Array<{ id: string } & AgentStatus>;
  /** Appends an assistant message to a thread's checkpoint. */
  postToThread: (threadId: string, text: string) => Promise<void>;
  timezone: string;
  newThreadId?: () => string;
}

/** A refusal whose message is written for the person or model that asked. */
export class TodoRefusal extends Error {}

const TIMELINE_IN_PROMPT = 20;
let threadCounter = 0;

export class TodoService implements TodoAccess, AmbientTodoAccess {
  private readonly newThreadId: () => string;

  constructor(private readonly deps: TodoServiceDeps) {
    this.newThreadId =
      deps.newThreadId ?? (() => `thread_todo_${Date.now().toString(36)}_${threadCounter++}`);
  }

  list(options?: { includeCompleted?: boolean }): Todo[] {
    return this.deps.todos.list(options).map((todo) => this.withCheckIn(todo));
  }

  get(id: string): Todo | undefined {
    const todo = this.deps.todos.get(id);
    return todo ? this.withCheckIn(todo) : undefined;
  }

  create(input: TodoCreateInput): Todo {
    return this.withCheckIn(this.deps.todos.create(input));
  }

  update(id: string, patch: TodoPatch, actor = "user"): Todo | undefined {
    const todo = this.deps.todos.update(id, patch, actor);
    if (!todo) return undefined;
    if (patch.completed !== undefined) this.syncSchedule(todo);
    return this.withCheckIn(todo);
  }

  linkThread(id: string, threadId: string): Todo | undefined {
    const todo = this.deps.todos.linkThread(id, threadId);
    return todo ? this.withCheckIn(todo) : undefined;
  }

  delete(id: string): boolean {
    const trigger = this.deps.triggers.forTodo(id);
    if (trigger) {
      this.deps.triggers.delete(trigger.id);
      this.deps.scheduler()?.reload();
    }
    return this.deps.todos.delete(id);
  }

  /** The user's assignment edit; refuses an unknown or unready agent and an invalid schedule. */
  assign(id: string, assignment: TodoAssignment): Todo | undefined {
    const current = this.deps.todos.get(id);
    if (!current) return undefined;
    if (assignment.owner) this.requireReady(assignment.owner);
    if (assignment.checkIn) this.requireCron(assignment.checkIn);

    const todo =
      assignment.owner !== undefined
        ? this.deps.todos.setOwner(id, assignment.owner, { actor: "user" })!
        : current;
    if (!todo.owner) {
      this.dropSchedule(id);
      return this.withCheckIn(todo);
    }
    const existing = this.deps.triggers.forTodo(id);
    const cron =
      assignment.checkIn !== undefined
        ? (assignment.checkIn ?? undefined)
        : existing
          ? existing.cron
          : TODO_DEFAULT_CHECK_IN;
    this.saveSchedule(todo, cron);
    return this.withCheckIn(todo);
  }

  checkInNow(id: string): { threadId: string; runId: string } {
    const todo = this.deps.todos.get(id);
    if (!todo) throw new TodoRefusal("That Todo no longer exists.");
    if (!todo.owner) throw new TodoRefusal("Assign this Todo to an agent before asking it to check in.");
    if (todo.completed) throw new TodoRefusal("This Todo is complete; reopen it to check in again.");
    if (!this.deps.automationsEnabled()) {
      throw new TodoRefusal("Check-ins are paused because Automations is turned off in Settings.");
    }
    const busy = this.busyReason(todo);
    if (busy) throw new TodoRefusal(busy);
    const trigger = this.deps.triggers.forTodo(id) ?? this.saveSchedule(todo, undefined);
    const started = this.deps.scheduler()?.runNow(trigger.id, "manual");
    if (!started) throw new TodoRefusal("The check-in could not start; try again in a moment.");
    return { threadId: started.handle.threadId, runId: started.handle.runId };
  }

  /** TriggerService hook: where a check-in runs and what it is told, or why it is skipped. */
  resolveCheckIn(
    trigger: TriggerDef,
    occurrence: TriggerOccurrence,
  ): { threadId: string; prompt: string } | { skip: string } {
    const todo = trigger.todoId ? this.deps.todos.get(trigger.todoId) : undefined;
    if (!todo) return { skip: "the Todo no longer exists" };
    if (!todo.owner) return { skip: "the Todo has no owner" };
    if (todo.completed) return { skip: "the Todo is complete" };
    const busy = this.busyReason(todo);
    if (busy) return { skip: busy };

    const threadId = this.backgroundThread(todo, todo.owner);
    const reason: TodoCheckInReason =
      occurrence.reason === "manual" || occurrence.reason === "handoff" ? occurrence.reason : "cron";
    this.deps.todos.appendEvent(todo.id, { kind: "check-in", actor: todo.owner, threadId, reason });
    return { threadId, prompt: this.checkInPrompt(this.deps.todos.get(todo.id)!, reason) };
  }

  /** A background run ended waiting on the user: an `ask_user` question or an approval. */
  recordPause(threadId: string): void {
    const todo = this.deps.todos.forBackgroundThread(threadId);
    if (todo?.owner) this.deps.todos.appendEvent(todo.id, { kind: "asked", actor: todo.owner, threadId });
  }

  todoForThread(threadId: string): Todo | undefined {
    const todo = this.deps.todos.forBackgroundThread(threadId);
    return todo ? this.withCheckIn(todo) : undefined;
  }

  recordProgress(
    threadId: string,
    update: { note: string } & Pick<TodoPatch, "completed" | "steps">,
  ): Todo {
    const todo = this.ownedBy(threadId);
    const { note, ...patch } = update;
    this.deps.todos.appendEvent(todo.id, { kind: "progress", actor: todo.owner, note });
    const updated = Object.keys(patch).length > 0 ? this.update(todo.id, patch, todo.owner) : undefined;
    return updated ?? this.get(todo.id)!;
  }

  async notifyUser(threadId: string, message: string): Promise<void> {
    const todo = this.ownedBy(threadId);
    const status = this.deps.agentStatus(todo.owner);
    const home =
      this.deps.threads.agentHome(todo.owner) ??
      this.deps.threads.create({
        threadId: this.newThreadId(),
        title: status?.name ?? todo.owner,
        agentId: todo.owner,
        agentHome: true,
        pinned: true,
      });
    if (this.deps.isRunning(home.threadId)) {
      throw new TodoRefusal("The user is in a conversation with you right now; send this at your next check-in.");
    }
    await this.deps.postToThread(home.threadId, message);
    this.deps.threads.update(home.threadId, {
      unread: true,
      lastMessage: message.slice(0, 500),
      lastMessageRole: "assistant",
    });
    this.deps.threads.touch(home.threadId);
    this.deps.todos.appendEvent(todo.id, { kind: "notified", actor: todo.owner, threadId: home.threadId, note: message });
  }

  reassign(threadId: string, toAgentId: string, note: string): Todo {
    const todo = this.ownedBy(threadId);
    if (toAgentId === todo.owner) throw new TodoRefusal("You already own this Todo.");
    const target = this.deps.agentStatus(toAgentId);
    if (!target) {
      const ids = this.deps.readyAgents().filter((agent) => agent.id !== todo.owner).map((agent) => agent.id);
      throw new TodoRefusal(
        `There is no agent "${toAgentId}". ${ids.length > 0 ? `You can hand off to: ${ids.join(", ")}.` : "No other agent is available."}`,
      );
    }
    if (!target.ready) {
      throw new TodoRefusal(`${target.name} is unavailable${target.detail ? ` (${target.detail})` : ""}; ask the user instead.`);
    }
    const handoffs = handoffsSinceUserAssigned(todo.history);
    if (handoffs.length >= TODO_MAX_HANDOFFS) {
      throw new TodoRefusal(
        `This Todo has been handed off ${handoffs.length} times since the user assigned it; ask the user how to proceed instead.`,
      );
    }
    if (handoffs.some((event) => event.actor === toAgentId)) {
      throw new TodoRefusal(`${target.name} already handed this Todo on; ask the user instead of handing it back.`);
    }

    const updated = this.deps.todos.setOwner(todo.id, toAgentId, { actor: todo.owner, note })!;
    const trigger = this.deps.triggers.forTodo(todo.id);
    if (trigger && this.deps.automationsEnabled()) this.deps.scheduler()?.runNow(trigger.id, "handoff");
    return this.withCheckIn(updated);
  }

  private ownedBy(threadId: string): StoredTodo & { owner: string } {
    const todo = this.deps.todos.forBackgroundThread(threadId);
    if (!todo?.owner) throw new TodoRefusal("This check-in no longer owns a Todo; end your turn.");
    return todo as StoredTodo & { owner: string };
  }

  private busyReason(todo: StoredTodo): string | undefined {
    if (!todo.backgroundThreadId) return undefined;
    if (this.deps.isRunning(todo.backgroundThreadId)) return "the previous check-in is still running";
    if (this.deps.threads.get(todo.backgroundThreadId)?.awaitingAction) {
      return "the previous check-in is waiting for your answer";
    }
    return undefined;
  }

  private backgroundThread(todo: StoredTodo, owner: string): string {
    if (todo.backgroundThreadId && this.deps.threads.get(todo.backgroundThreadId)) return todo.backgroundThreadId;
    const thread = this.deps.threads.create({
      threadId: this.newThreadId(),
      title: todo.title,
      source: "trigger",
      agentId: owner,
      background: true,
      todoId: todo.id,
    });
    this.deps.todos.setBackgroundThread(todo.id, thread.threadId);
    return thread.threadId;
  }

  private requireReady(agentId: string): void {
    const status = this.deps.agentStatus(agentId);
    if (!status) throw new TodoRefusal(`There is no enabled agent "${agentId}".`);
    if (!status.ready) {
      throw new TodoRefusal(`${status.name} is unavailable${status.detail ? ` (${status.detail})` : ""}.`);
    }
  }

  private requireCron(cron: string): void {
    try {
      new CronTime(cron, this.deps.timezone);
    } catch {
      throw new TodoRefusal(`"${cron}" is not a valid check-in schedule; use a five-field cron expression.`);
    }
  }

  private saveSchedule(todo: StoredTodo, cron: string | undefined): TriggerDef {
    const enabled = !todo.completed;
    const existing = this.deps.triggers.forTodo(todo.id);
    // A patch cannot clear a cron, so dropping the schedule recreates the trigger under the same id.
    if (existing && !cron && existing.cron) this.deps.triggers.delete(existing.id);
    const kept = existing && (cron || !existing.cron) ? existing : undefined;
    const saved = kept
      ? this.deps.triggers.update(kept.id, { enabled, ...(cron ? { cron } : {}), timezone: this.deps.timezone })!
      : this.deps.triggers.create({
          id: `todo_${todo.id}`,
          kind: "cron",
          name: todo.title,
          todoId: todo.id,
          enabled,
          ...(cron ? { cron } : {}),
          timezone: this.deps.timezone,
        });
    this.deps.scheduler()?.reload();
    return saved;
  }

  private syncSchedule(todo: StoredTodo): void {
    const trigger = this.deps.triggers.forTodo(todo.id);
    if (!trigger || trigger.enabled === !todo.completed) return;
    this.deps.triggers.update(trigger.id, { enabled: !todo.completed });
    this.deps.scheduler()?.reload();
  }

  private dropSchedule(id: string): void {
    const trigger = this.deps.triggers.forTodo(id);
    if (!trigger) return;
    this.deps.triggers.delete(trigger.id);
    this.deps.scheduler()?.reload();
  }

  private withCheckIn(todo: StoredTodo): Todo {
    const trigger = todo.owner ? this.deps.triggers.forTodo(todo.id) : undefined;
    if (!trigger?.cron) return todo;
    const nextRunAt = trigger.enabled ? this.deps.scheduler()?.nextRunAt(trigger.id) : undefined;
    return {
      ...todo,
      checkIn: {
        cron: trigger.cron,
        timezone: trigger.timezone ?? this.deps.timezone,
        ...(nextRunAt ? { nextRunAt } : {}),
      },
    };
  }

  private checkInPrompt(todo: StoredTodo & { owner?: string }, reason: TodoCheckInReason): string {
    const handoff = reason === "handoff" ? [...todo.history].reverse().find((event) => event.kind === "assigned") : undefined;
    const why =
      reason === "handoff"
        ? `${this.agentName(handoff?.actor ?? "")} handed this Todo to you${handoff?.note ? ` with this note: ${handoff.note}` : "."}`
        : reason === "manual"
          ? "The user asked you to check in now."
          : "This is a scheduled check-in.";
    const details = {
      title: todo.title,
      ...(todo.notes ? { notes: todo.notes } : {}),
      ...(todo.dueDate ? { dueDate: todo.dueDate } : {}),
      importance: todo.importance,
      ...(todo.steps.length > 0 ? { steps: todo.steps } : {}),
      linkedConversations: todo.threadIds.length,
    };
    const timeline = todo.history.slice(-TIMELINE_IN_PROMPT).map((event) => `- ${describeEvent(event, (id) => this.agentName(id))}`);
    const others = this.deps.readyAgents().filter((agent) => agent.id !== todo.owner);
    return [
      `Check-in on the Todo you own. ${why}`,
      "",
      "Todo:",
      JSON.stringify(details, null, 2),
      "",
      "Timeline (oldest first):",
      ...(timeline.length > 0 ? timeline : ["- (nothing yet)"]),
      "",
      "Agents you can hand off to with reassign_todo:",
      ...(others.length > 0 ? others.map((agent) => `- ${agent.id}: ${agent.name}. ${agent.description}`) : ["- (none)"]),
    ].join("\n");
  }

  private agentName(id: string): string {
    if (id === "user") return "The user";
    return this.deps.agentStatus(id)?.name ?? id;
  }
}

/** Agent-acted assignments since the user last assigned the Todo. */
function handoffsSinceUserAssigned(history: readonly TodoEvent[]): TodoEvent[] {
  const handoffs: TodoEvent[] = [];
  for (const event of [...history].reverse()) {
    if (event.kind !== "assigned") continue;
    if (event.actor === "user") break;
    handoffs.push(event);
  }
  return handoffs;
}

function describeEvent(event: TodoEvent, name: (id: string) => string): string {
  const who = name(event.actor);
  const at = event.at.slice(0, 16).replace("T", " ");
  switch (event.kind) {
    case "assigned":
      return `${at} ${who} assigned it to ${name(event.agentId ?? "")}${event.note ? `: ${event.note}` : ""}`;
    case "unassigned":
      return `${at} ${who} took it back`;
    case "check-in":
      return `${at} ${who} checked in (${event.reason ?? "cron"})`;
    case "progress":
      return `${at} ${who} noted: ${event.note ?? ""}`;
    case "completed":
      return `${at} ${who} marked it complete`;
    case "reopened":
      return `${at} ${who} reopened it`;
    case "notified":
      return `${at} ${who} told the user: ${event.note ?? ""}`;
    case "asked":
      return `${at} ${who} asked the user a question`;
  }
}
