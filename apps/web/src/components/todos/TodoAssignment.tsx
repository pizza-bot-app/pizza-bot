import { useEffect, useState } from "react";
import type { Todo, TodoAssignment as TodoAssignmentPatch } from "@pizza-bot/core";
import { errorMessage, type AgentCatalogEntryInfo } from "@/api-client";
import { AlarmClock, Bell, Bot, CalendarClock, ExternalLink, Gauge, RefreshCw } from "lucide-react";
import { recipientOptions, type RecipientOption } from "../../lib/thread-agent.js";
import {
  CHECK_IN_ON_REQUEST_LABEL,
  CHECK_IN_PRESETS,
  activeSnooze,
  checkInChoice,
  graphIdOf,
  localDateTimeToIso,
  nextCheckInLabel,
  ownerValue,
  parseCheckInLimit,
  snoozePresets,
  whenLabel,
} from "../../lib/todo-ownership.js";
import { L } from "../../lexicon.js";

export interface TodoGraphOption {
  id: string;
  name: string;
}

export interface TodoAssignmentProps {
  todo: Todo;
  agents: readonly AgentCatalogEntryInfo[];
  graphs?: readonly TodoGraphOption[];
  automationsEnabled: boolean;
  onAssign: (patch: TodoAssignmentPatch) => Promise<void>;
  onCheckIn: () => Promise<void>;
  onOpenWorkThread: (threadId: string) => void;
}

/** Owner options: Me, then enabled agents; a current owner outside that list stays shown. */
export function ownerOptions(
  agents: readonly AgentCatalogEntryInfo[],
  owner: string | undefined,
): RecipientOption[] {
  const options = recipientOptions(agents, L.todoAssignedToMe);
  if (owner && !graphIdOf(owner) && !options.some((option) => option.id === owner)) {
    options.push({ id: owner, name: owner, disabledReason: L.agentUnavailable });
  }
  return options;
}

/** Graph owner options as `graph:<id>` values; a current graph owner outside the list stays shown. */
export function workflowOptions(
  graphs: readonly TodoGraphOption[],
  owner: string | undefined,
): RecipientOption[] {
  const options: RecipientOption[] = [...graphs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((graph) => ({ id: `graph:${graph.id}`, name: graph.name }));
  const current = owner ? graphIdOf(owner) : undefined;
  if (current && !graphs.some((graph) => graph.id === current)) {
    options.push({ id: owner!, name: current, disabledReason: L.agentUnavailable });
  }
  return options;
}

function OwnerOption({ option, owner }: { option: RecipientOption; owner: string | undefined }) {
  return (
    <option
      value={option.id ?? ""}
      disabled={option.disabledReason !== undefined && option.id !== owner}
      title={option.disabledReason}
    >
      {option.disabledReason ? `${option.name} (${option.disabledReason})` : option.name}
    </option>
  );
}

export function TodoAssignment({
  todo,
  agents,
  graphs = [],
  automationsEnabled,
  onAssign,
  onCheckIn,
  onOpenWorkThread,
}: TodoAssignmentProps) {
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const owner = ownerValue(todo);
  const options = ownerOptions(agents, owner);
  const workflows = workflowOptions(graphs, owner);
  const choice = checkInChoice(todo.checkIn?.cron);
  const next = nextCheckInLabel(todo.checkIn?.nextRunAt);

  const checkInNow = async () => {
    setCheckingIn(true);
    setCheckInError(null);
    try {
      await onCheckIn();
    } catch (error) {
      setCheckInError(errorMessage(error) ?? "The check-in could not start.");
    } finally {
      setCheckingIn(false);
    }
  };

  return (
    <section className="todo-detail-section">
      <h3 className="todo-detail-section-title">
        <Bot size={14} /> {L.todoAssignedTo}
      </h3>
      <div className="todo-assign-row">
        <select
          className="recipient-select"
          aria-label={L.todoAssignedTo}
          value={owner ?? ""}
          onChange={(event) => void onAssign({ owner: event.target.value || null })}
        >
          {options.map((option) => (
            <OwnerOption key={option.id ?? ""} option={option} owner={owner} />
          ))}
          {workflows.length > 0 && (
            <optgroup label={L.todoWorkflows}>
              {workflows.map((option) => (
                <OwnerOption key={option.id} option={option} owner={owner} />
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {owner && (
        <>
          <div className="todo-assign-row">
            <CalendarClock size={14} aria-hidden="true" className="todo-assign-icon" />
            <span className="todo-assign-label">{L.todoCheckIn}</span>
            <select
              className="recipient-select"
              aria-label={L.todoCheckIn}
              value={choice === "custom" ? todo.checkIn!.cron : (choice ?? "")}
              onChange={(event) => void onAssign({ checkIn: event.target.value || null })}
            >
              {CHECK_IN_PRESETS.map((preset) => (
                <option key={preset.cron} value={preset.cron}>
                  {preset.label}
                </option>
              ))}
              {choice === "custom" && (
                <option value={todo.checkIn!.cron}>Custom ({todo.checkIn!.cron})</option>
              )}
              <option value="">{CHECK_IN_ON_REQUEST_LABEL}</option>
            </select>
            {next && (
              <span className="field-hint" title={todo.checkIn?.nextRunAt}>
                {L.todoNextCheckIn} {next}
              </span>
            )}
          </div>
          <TodoSnooze todo={todo} onAssign={onAssign} />
          {todo.owner && (
            <div className="todo-assign-row">
              <Bell size={14} aria-hidden="true" className="todo-assign-icon" />
              <span className="todo-assign-label">{L.todoUpdates}</span>
              <select
                className="recipient-select"
                aria-label={L.todoUpdates}
                value={todo.notify}
                onChange={(event) =>
                  void onAssign({ notify: event.target.value === "digest" ? "digest" : "immediate" })
                }
              >
                <option value="immediate">{L.todoUpdatesImmediate}</option>
                <option value="digest">{L.todoUpdatesDigest}</option>
              </select>
            </div>
          )}
          <TodoBudget todo={todo} onAssign={onAssign} />
          <div className="todo-assign-row">
            <button
              type="button"
              className="btn-secondary"
              disabled={checkingIn || todo.completed || !automationsEnabled}
              onClick={() => void checkInNow()}
            >
              <RefreshCw size={14} /> {L.todoCheckInNow}
            </button>
            {todo.backgroundThreadId && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onOpenWorkThread(todo.backgroundThreadId!)}
              >
                <ExternalLink size={14} /> {L.todoOpenWorkThread}
              </button>
            )}
          </div>
          {!automationsEnabled && <p className="field-hint">{L.todoCheckInsPaused}</p>}
          {checkInError && (
            <p className="field-hint error" role="alert">
              {checkInError}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function TodoSnooze({
  todo,
  onAssign,
}: {
  todo: Todo;
  onAssign: (patch: TodoAssignmentPatch) => Promise<void>;
}) {
  const snoozed = activeSnooze(todo.snoozedUntil);
  const [custom, setCustom] = useState("");
  const presets = snoozePresets();

  return (
    <div className="todo-assign-row todo-snooze">
      <AlarmClock size={14} aria-hidden="true" className="todo-assign-icon" />
      <span className="todo-assign-label">{L.todoSnooze}</span>
      {snoozed ? (
        <>
          <span className="todo-snoozed" title={snoozed}>
            {L.todoSnoozedUntil} {whenLabel(snoozed)}
          </span>
          <button type="button" className="btn-secondary" onClick={() => void onAssign({ snoozedUntil: null })}>
            {L.todoUnsnooze}
          </button>
        </>
      ) : (
        <>
          <select
            className="recipient-select"
            aria-label={L.todoSnooze}
            value=""
            onChange={(event) => {
              if (event.target.value) void onAssign({ snoozedUntil: event.target.value });
            }}
          >
            <option value="">{L.todoSnoozeChoose}</option>
            {presets.map((preset) => (
              <option key={preset.label} value={preset.until}>
                {preset.label}
              </option>
            ))}
          </select>
          <input
            type="datetime-local"
            className="field-input todo-snooze-custom"
            aria-label={L.todoSnoozeCustom}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={localDateTimeToIso(custom) === undefined}
            onClick={() => {
              const until = localDateTimeToIso(custom);
              if (until) {
                setCustom("");
                void onAssign({ snoozedUntil: until });
              }
            }}
          >
            {L.todoSnooze}
          </button>
        </>
      )}
    </div>
  );
}

function TodoBudget({
  todo,
  onAssign,
}: {
  todo: Todo;
  onAssign: (patch: TodoAssignmentPatch) => Promise<void>;
}) {
  const saved = todo.budget ? String(todo.budget.maxCheckIns) : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const parsed = parseCheckInLimit(draft);

  const commit = () => {
    if (parsed === undefined) {
      setDraft(saved);
      return;
    }
    if (parsed !== (todo.budget?.maxCheckIns ?? null)) void onAssign({ maxCheckIns: parsed });
  };

  return (
    <div className="todo-assign-row">
      <Gauge size={14} aria-hidden="true" className="todo-assign-icon" />
      <span className="todo-assign-label">{L.todoBudget}</span>
      <input
        className="field-input todo-budget-input"
        inputMode="numeric"
        aria-label={L.todoBudget}
        placeholder={L.todoBudgetNone}
        value={draft}
        aria-invalid={parsed === undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") setDraft(saved);
        }}
      />
      {todo.budget && (
        <span className="field-hint">
          {todo.budget.used} of {todo.budget.maxCheckIns} used
        </span>
      )}
    </div>
  );
}
