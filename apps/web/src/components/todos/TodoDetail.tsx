import { useEffect, useState, type FormEvent } from "react";
import { isTodoDueDate, type Todo, type TodoPatch, type TodoStep } from "@pizza-bot/core";
import { errorMessage } from "@/api-client";
import {
  CalendarDays,
  ChevronLeft,
  Circle,
  CircleCheck,
  ListChecks,
  MessageSquare,
  Plus,
  Star,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { relativeTime } from "../../lib/conversation.js";
import { dueLabel, isOverdue } from "../../lib/todo-views.js";
import { L } from "../../lexicon.js";

export interface TodoDetailProps {
  todo: Todo;
  today: string;
  threadTitles: ReadonlyMap<string, string>;
  onUpdate: (patch: TodoPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onUnlinkThread: (threadId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
  onBack?: () => void;
}

type StepDraft = Pick<TodoStep, "title" | "completed"> & { id?: string };

const stepsPatch = (steps: readonly StepDraft[]) =>
  steps.map((step) => ({
    ...(step.id ? { id: step.id } : {}),
    title: step.title,
    completed: step.completed,
  }));

export function TodoDetail({
  todo,
  today,
  threadTitles,
  onUpdate,
  onDelete,
  onUnlinkThread,
  onOpenThread,
  onBack,
}: TodoDetailProps) {
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [newStep, setNewStep] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => setTitle(todo.title), [todo.title]);
  useEffect(() => setNotes(todo.notes), [todo.notes]);

  const important = todo.importance === "high";

  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(todo.title);
    else if (next !== todo.title) void onUpdate({ title: next });
  };

  const saveNotes = () => {
    if (notes !== todo.notes) void onUpdate({ notes });
  };

  const saveSteps = (steps: readonly StepDraft[]) =>
    void onUpdate({ steps: stepsPatch(steps) });

  const addStep = (event: FormEvent) => {
    event.preventDefault();
    const stepTitle = newStep.trim();
    if (!stepTitle) return;
    saveSteps([...todo.steps, { title: stepTitle, completed: false }]);
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

      <section className="todo-detail-section">
        <h3 className="todo-detail-section-title">
          <ListChecks size={14} /> Steps
        </h3>
        {todo.steps.length > 0 && (
          <ul className="todo-steps">
            {todo.steps.map((step) => (
              <TodoStepRow
                key={step.id}
                step={step}
                onToggle={() =>
                  saveSteps(
                    todo.steps.map((s) => (s.id === step.id ? { ...s, completed: !s.completed } : s)),
                  )
                }
                onRename={(stepTitle) =>
                  saveSteps(todo.steps.map((s) => (s.id === step.id ? { ...s, title: stepTitle } : s)))
                }
                onRemove={() => saveSteps(todo.steps.filter((s) => s.id !== step.id))}
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
            value={todo.dueDate ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) void onUpdate({ dueDate: null });
              else if (isTodoDueDate(value)) void onUpdate({ dueDate: value });
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
  step: TodoStep;
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
