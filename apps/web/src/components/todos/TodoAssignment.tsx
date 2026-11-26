import { useState } from "react";
import type { Todo, TodoAssignment as TodoAssignmentPatch } from "@pizza-bot/core";
import { errorMessage, type AgentCatalogEntryInfo } from "@/api-client";
import { Bot, CalendarClock, ExternalLink, RefreshCw } from "lucide-react";
import { recipientOptions, type RecipientOption } from "../../lib/thread-agent.js";
import {
  CHECK_IN_ON_REQUEST_LABEL,
  CHECK_IN_PRESETS,
  checkInChoice,
  nextCheckInLabel,
} from "../../lib/todo-ownership.js";
import { L } from "../../lexicon.js";

export interface TodoAssignmentProps {
  todo: Todo;
  agents: readonly AgentCatalogEntryInfo[];
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
  if (owner && !options.some((option) => option.id === owner)) {
    options.push({ id: owner, name: owner, disabledReason: L.agentUnavailable });
  }
  return options;
}

export function TodoAssignment({
  todo,
  agents,
  automationsEnabled,
  onAssign,
  onCheckIn,
  onOpenWorkThread,
}: TodoAssignmentProps) {
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const options = ownerOptions(agents, todo.owner);
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
          value={todo.owner ?? ""}
          onChange={(event) => void onAssign({ owner: event.target.value || null })}
        >
          {options.map((option) => (
            <option
              key={option.id ?? ""}
              value={option.id ?? ""}
              disabled={option.disabledReason !== undefined && option.id !== todo.owner}
              title={option.disabledReason}
            >
              {option.disabledReason ? `${option.name} (${option.disabledReason})` : option.name}
            </option>
          ))}
        </select>
      </div>

      {todo.owner && (
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
