import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  type Todo,
  type TodoAssignment as TodoAssignmentPatch,
  type TodoPatch,
} from "@pizza-bot/core";
import { errorMessage, type AgentCatalogEntryInfo } from "@/api-client";
import {
  Bot,
  CalendarDays,
  ChevronLeft,
  Circle,
  CircleCheck,
  CornerLeftUp,
  ListChecks,
  ListTree,
  MessageSquare,
  Plus,
  Star,
  StickyNote,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { relativeTime } from "../../lib/conversation.js";
import { dueLabel, isOverdue } from "../../lib/todo-views.js";
import { graphIdOf, ownerValue, workOwnerOf, type WorkOwner } from "../../lib/todo-ownership.js";
import { L } from "../../lexicon.js";
import { TodoAssignment, type TodoGraphOption } from "./TodoAssignment.js";
import { TodoTimeline } from "./TodoTimeline.js";
import {
  applyStepEdit,
  serialQueue,
  stepDrafts,
  stepsPatch,
  type StepDraft,
  type StepEdit,
} from "../../lib/todo-steps.js";
import { dueDateCommit, DUE_DATE_MAX, DUE_DATE_MIN } from "../../lib/todo-views.js";

/** Identifies a work thread (an agent's, or a graph run) so it opens correctly while unlisted. */
export type WorkThreadHint = WorkOwner & { title: string };

export interface TodoDetailProps {
  todo: Todo;
  today: string;
  threadTitles: ReadonlyMap<string, string>;
  agents: readonly AgentCatalogEntryInfo[];
  graphs?: readonly TodoGraphOption[];
  /** Every Todo, for this one's parent and subtasks. */
  todos?: readonly Todo[];
  automationsEnabled: boolean;
  onUpdate: (patch: TodoPatch & TodoAssignmentPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onUnlinkThread: (threadId: string) => Promise<void>;
  onCheckIn: () => Promise<void>;
  onOpenThread: (threadId: string, workThread?: WorkThreadHint) => void;
  onSelectTodo?: (todoId: string) => void;
  onBack?: () => void;
}

/** An owner or actor's display name: an agent's name, or a `graph:<id>`'s graph name. */
export function ownerDisplayName(
  id: string,
  agents: readonly AgentCatalogEntryInfo[],
  graphs: readonly TodoGraphOption[],
): string {
  const graphId = graphIdOf(id);
  if (graphId) return graphs.find((graph) => graph.id === graphId)?.name ?? graphId;
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

let localStepKey = 0;

export function TodoDetail({
  todo,
  today,
  threadTitles,
  agents,
  graphs = [],
  todos = [],
  automationsEnabled,
  onUpdate,
  onDelete,
  onUnlinkThread,
  onCheckIn,
  onOpenThread,
  onSelectTodo,
  onBack,
}: TodoDetailProps) {
  const nameOf = (id: string) => ownerDisplayName(id, agents, graphs);
  const owner = ownerValue(todo);
  const parent = todo.parentTodoId ? todos.find((candidate) => candidate.id === todo.parentTodoId) : undefined;
  const subtasks = todos.filter((candidate) => candidate.parentTodoId === todo.id);
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [newStep, setNewStep] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => setTitle(todo.title), [todo.title]);
  useEffect(() => setNotes(todo.notes), [todo.notes]);

  // Each step PATCH replaces the whole list, so edits apply locally first and save one at a
  // time from the latest local list; the server's list is adopted only when none are in flight.
  const [steps, setSteps] = useState<StepDraft[]>(() => stepDrafts(todo.steps));
  const stepsRef = useRef(steps);
  const serverSteps = useRef(todo.steps);
  serverSteps.current = todo.steps;
  const stepSaves = useRef(serialQueue()).current;
  useEffect(() => {
    if (stepSaves.pending > 0) return;
    const next = stepDrafts(todo.steps);
    stepsRef.current = next;
    setSteps(next);
  }, [todo.steps, stepSaves]);

  const [dueDraft, setDueDraft] = useState(todo.dueDate ?? "");
  useEffect(() => setDueDraft(todo.dueDate ?? ""), [todo.dueDate]);
  const saveDueDate = () => {
    const commit = dueDateCommit(dueDraft, todo.dueDate);
    if (commit === "revert") setDueDraft(todo.dueDate ?? "");
    else if (commit !== "unchanged") void onUpdate({ dueDate: commit });
  };

  const important = todo.importance === "high";

  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(todo.title);
    else if (next !== todo.title) void onUpdate({ title: next });
  };

  const saveNotes = () => {
    if (notes !== todo.notes) void onUpdate({ notes });
  };

  const editSteps = (edit: StepEdit) => {
    const next = applyStepEdit(stepsRef.current, edit);
    stepsRef.current = next;
    setSteps(next);
    void stepSaves
      .run(() => onUpdate({ steps: stepsPatch(stepsRef.current) }))
      .catch(() => undefined)
      .finally(() => {
        if (stepSaves.pending > 0) return;
        const latest = stepDrafts(serverSteps.current);
        stepsRef.current = latest;
        setSteps(latest);
      });
  };

  const addStep = (event: FormEvent) => {
    event.preventDefault();
    const stepTitle = newStep.trim();
    if (!stepTitle) return;
    editSteps({ kind: "add", key: `local-${localStepKey++}`, title: stepTitle });
    setNewStep("");
  };

  const runDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(errorMessage(error) ?? "The todo could not be deleted.");
      setDeleting(false);
    }
  };

  return (
    <div className="todo-detail">
      {onBack && (
        <button className="module-detail-back" onClick={onBack}>
          <ChevronLeft size={18} /> {L.todosSection}
        </button>
      )}

      <header className="todo-detail-head">
        <button
          type="button"
          role="checkbox"
          aria-checked={todo.completed}
          aria-label={todo.completed ? "Mark not completed" : "Mark completed"}
          className="todo-check large"
          onClick={() => void onUpdate({ completed: !todo.completed })}
        >
          {todo.completed ? <CircleCheck size={22} /> : <Circle size={22} />}
        </button>
        <input
          className={`todo-detail-title${todo.completed ? " completed" : ""}`}
          aria-label="Title"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") setTitle(todo.title);
          }}
        />
        <button
          type="button"
          className={`todo-star${important ? " active" : ""}`}
          aria-pressed={important}
          aria-label={important ? "Remove importance" : "Mark important"}
          onClick={() => void onUpdate({ importance: important ? "normal" : "high" })}
        >
          <Star size={18} fill={important ? "currentColor" : "none"} />
        </button>
      </header>

      <TodoAssignment
        todo={todo}
        agents={agents}
        automationsEnabled={automationsEnabled}
        onAssign={onUpdate}
        onCheckIn={onCheckIn}
        graphs={graphs}
        onOpenWorkThread={(threadId) =>
          onOpenThread(threadId, owner ? { ...workOwnerOf(owner), title: todo.title } : undefined)
        }
      />

      {parent && (
        <p className="todo-parent-link">
          <CornerLeftUp size={14} aria-hidden="true" /> {L.todoPartOf}{" "}
          <button type="button" className="todo-timeline-link" onClick={() => onSelectTodo?.(parent.id)}>
            {parent.title}
          </button>
        </p>
      )}

      {subtasks.length > 0 && (
        <section className="todo-detail-section">
          <h3 className="todo-detail-section-title">
            <ListTree size={14} /> {L.todoSubtasks}
          </h3>
          <ul className="todo-subtasks">
            {subtasks.map((child) => {
              const childOwner = ownerValue(child);
              return (
                <li key={child.id} className={`todo-subtask${child.completed ? " completed" : ""}`}>
                  {child.completed ? <CircleCheck size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
                  <button type="button" className="todo-thread-open" onClick={() => onSelectTodo?.(child.id)}>
                    {child.title}
                  </button>
                  {childOwner && (
                    <span className="todo-owner">
                      {graphIdOf(childOwner) ? <Workflow size={11} aria-hidden="true" /> : <Bot size={11} aria-hidden="true" />}
                      {nameOf(childOwner)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="todo-detail-section">
        <h3 className="todo-detail-section-title">
          <ListChecks size={14} /> Steps
        </h3>
        {steps.length > 0 && (
          <ul className="todo-steps">
            {steps.map((step) => (
              <TodoStepRow
                key={step.key}
                step={step}
                onToggle={() => editSteps({ kind: "toggle", key: step.key })}
                onRename={(stepTitle) => editSteps({ kind: "rename", key: step.key, title: stepTitle })}
                onRemove={() => editSteps({ kind: "remove", key: step.key })}
              />
            ))}
          </ul>
        )}
        <form className="todo-step-add" onSubmit={addStep}>
          <Plus size={14} aria-hidden="true" />
          <input
            className="field-input"
            aria-label="Add a step"
            placeholder="Add a step"
            value={newStep}
            maxLength={200}
            onChange={(event) => setNewStep(event.target.value)}
          />
        </form>
      </section>

      <section className="todo-detail-section">
        <h3 className="todo-detail-section-title">
          <CalendarDays size={14} /> Due date
        </h3>
        <div className="todo-due-field">
          <input
            type="date"
            className="field-input"
            aria-label="Due date"
            min={DUE_DATE_MIN}
            max={DUE_DATE_MAX}
            value={dueDraft}
            onChange={(event) => setDueDraft(event.target.value)}
            onBlur={saveDueDate}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              else if (event.key === "Escape") setDueDraft(todo.dueDate ?? "");
            }}
          />
          {todo.dueDate !== undefined && (
            <>
              <span className={`todo-due${isOverdue(todo, today) ? " overdue" : ""}`}>
                {dueLabel(todo.dueDate, today)}
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onUpdate({ dueDate: null })}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </section>

      <section className="todo-detail-section">
        <h3 className="todo-detail-section-title">
          <MessageSquare size={14} /> Conversations
        </h3>
        {todo.threadIds.length === 0 ? (
          <p className="field-hint">Flag a conversation from its header to link it here.</p>
        ) : (
          <ul className="todo-threads">
            {todo.threadIds.map((threadId) => (
              <li key={threadId} className="todo-thread">
                <button type="button" className="todo-thread-open" onClick={() => onOpenThread(threadId)}>
                  {threadTitles.get(threadId) ?? "Conversation"}
                </button>
                <button
                  type="button"
                  className="todo-icon-btn"
                  aria-label={`Unlink “${threadTitles.get(threadId) ?? "conversation"}”`}
                  title="Unlink"
                  onClick={() => void onUnlinkThread(threadId)}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="todo-detail-section">
        <h3 className="todo-detail-section-title">
          <StickyNote size={14} /> Notes
        </h3>
        <textarea
          className="field-input todo-notes"
          aria-label="Notes"
          rows={6}
          value={notes}
          maxLength={10_000}
          placeholder="Add a note"
          onChange={(event) => setNotes(event.target.value)}
          onBlur={saveNotes}
        />
      </section>

      <TodoTimeline
        history={todo.history ?? []}
        nameOf={nameOf}
        onOpenThread={(entry) =>
          onOpenThread(
            entry.threadId,
            entry.workOwner ? { ...workOwnerOf(entry.workOwner), title: todo.title } : undefined,
          )
        }
        {...(onSelectTodo ? { onOpenTodo: onSelectTodo } : {})}
      />

      <footer className="todo-detail-foot">
        <span className="field-hint">
          {todo.completed && todo.completedAt
            ? `Completed ${relativeTime(todo.completedAt)}`
            : `Created ${relativeTime(todo.createdAt)}`}
        </span>
        <span className="resource-editor-actions-spacer" />
        <button
          type="button"
          className="btn-secondary resource-editor-delete"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 size={14} /> Delete
        </button>
      </footer>

      {confirmingDelete && (
        <ConfirmationDialog
          title={`Delete ${L.todo.toLowerCase()}?`}
          message={`Delete “${todo.title}”? This can’t be undone.`}
          confirmLabel="Delete"
          destructive
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            setConfirmingDelete(false);
            setDeleteError(null);
          }}
          onConfirm={() => void runDelete()}
        />
      )}
    </div>
  );
}

function TodoStepRow({
  step,
  onToggle,
  onRename,
  onRemove,
}: {
  step: StepDraft;
  onToggle: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [title, setTitle] = useState(step.title);
  useEffect(() => setTitle(step.title), [step.title]);

  return (
    <li className={`todo-step${step.completed ? " completed" : ""}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={step.completed}
        aria-label={step.completed ? `Mark step “${step.title}” not done` : `Complete step “${step.title}”`}
        className="todo-check"
        onClick={onToggle}
      >
        {step.completed ? <CircleCheck size={16} /> : <Circle size={16} />}
      </button>
      <input
        className="todo-step-title"
        aria-label="Step"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          const next = title.trim();
          if (!next) setTitle(step.title);
          else if (next !== step.title) onRename(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") setTitle(step.title);
        }}
      />
      <button
        type="button"
        className="todo-icon-btn"
        aria-label={`Remove step “${step.title}”`}
        title="Remove step"
        onClick={onRemove}
      >
        <X size={14} />
      </button>
    </li>
  );
}
