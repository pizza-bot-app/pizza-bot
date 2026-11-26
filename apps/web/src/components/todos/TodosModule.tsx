import { useMemo, useState, type FormEvent } from "react";
import type { Todo, TodoCreateInput, TodoPatch } from "@pizza-bot/core";
import { errorMessage } from "@/api-client";
import { CalendarDays, Circle, CircleCheck, ListTodo, MessageSquare, Plus, Star } from "lucide-react";
import { ModuleHeader } from "../ModuleHeader.js";
import { useAppToast } from "../AppToast.js";
import { useIsMobile } from "../../use-is-mobile.js";
import {
  SELECTABLE_LIST_ZONE,
  useSelectableListNavigation,
} from "../../use-selectable-list-navigation.js";
import {
  TODO_VIEWS,
  dueLabel,
  isOverdue,
  localToday,
  stepProgress,
  todoViewCounts,
  todosInView,
  type TodoView,
} from "../../lib/todo-views.js";
import { L } from "../../lexicon.js";
import { TodoDetail } from "./TodoDetail.js";

export interface TodosModuleProps {
  todos: Todo[];
  threadTitles: ReadonlyMap<string, string>;
  /** Initially selected Todo; remount the module to focus another. */
  focusId?: string;
  today?: string;
  onCreate: (input: TodoCreateInput) => Promise<Todo>;
  onUpdate: (id: string, patch: TodoPatch) => Promise<Todo>;
  onDelete: (id: string) => Promise<boolean>;
  onUnlinkThread: (id: string, threadId: string) => Promise<Todo>;
  onOpenThread: (threadId: string) => void;
}

const VIEW_LABELS: Record<TodoView, string> = {
  today: L.todoViewToday,
  planned: L.todoViewPlanned,
  important: L.todoViewImportant,
  all: L.todoViewAll,
  completed: L.todoViewCompleted,
};

const EMPTY_SUB: Record<TodoView, string> = {
  today: "Todos due today or overdue appear here.",
  planned: "Todos with a due date appear here.",
  important: "Star a todo to mark it important.",
  all: "Add a todo above, or flag a conversation from its header.",
  completed: "Completed todos appear here.",
};

/** A quick add inherits the view's meaning so the new row stays visible. */
function quickAddDefaults(view: TodoView, today: string): Partial<TodoCreateInput> {
  if (view === "today" || view === "planned") return { dueDate: today };
  if (view === "important") return { importance: "high" };
  return {};
}

export function TodosModule({
  todos,
  threadTitles,
  focusId,
  today: todayOverride,
  onCreate,
  onUpdate,
  onDelete,
  onUnlinkThread,
  onOpenThread,
}: TodosModuleProps) {
  const notify = useAppToast();
  const isMobile = useIsMobile();
  const today = todayOverride ?? localToday();
  const [view, setView] = useState<TodoView>("all");
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => todosInView(todos, view, today), [todos, view, today]);
  const counts = useMemo(() => todoViewCounts(todos, today), [todos, today]);
  const selected = todos.find((todo) => todo.id === selectedId) ?? null;

  const listNavigation = useSelectableListNavigation({
    itemIds: rows.map((todo) => todo.id),
    selectedId,
    onSelect: setSelectedId,
    searchEnabled: false,
  });

  const report = (title: string, error: unknown) =>
    notify({ title, description: errorMessage(error), tone: "error" });

  const update = async (id: string, patch: TodoPatch) => {
    try {
      await onUpdate(id, patch);
    } catch (error) {
      report("Could not update todo", error);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      await onCreate({ title, ...quickAddDefaults(view, today) });
      setDraft("");
    } catch (error) {
      report("Could not add todo", error);
    } finally {
      setAdding(false);
    }
  };

  const mobileDetailOpen = selected !== null;

  return (
    <div className="module todos-module">
      <ModuleHeader icon={<ListTodo size={18} />} title={L.todosSection} count={counts.all} />
      <div
        className={`module-body${isMobile ? (mobileDetailOpen ? " mobile-detail" : " mobile-list") : ""}`}
      >
        <div className="resource-list todo-list">
          <div className="resource-list-header todo-list-header">
            <div className="segmented todo-views" role="tablist" aria-label={`${L.todos} views`}>
              {TODO_VIEWS.map((key) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={view === key}
                  className={`segmented-btn${view === key ? " active" : ""}`}
                  onClick={() => setView(key)}
                >
                  {VIEW_LABELS[key]}
                  {key !== "completed" && counts[key] > 0 && (
                    <span className="segmented-count">{counts[key]}</span>
                  )}
                </button>
              ))}
            </div>
            {view !== "completed" && (
              <form className="todo-quick-add" onSubmit={(event) => void add(event)}>
                <Plus size={16} className="todo-quick-add-icon" aria-hidden="true" />
                <input
                  className="sidebar-search"
                  aria-label={L.addTodoPlaceholder}
                  placeholder={L.addTodoPlaceholder}
                  value={draft}
                  maxLength={200}
                  disabled={adding}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </form>
            )}
          </div>

          <div className="resource-list-scroll">
            {rows.length === 0 ? (
              <div className="sidebar-empty">
                <div className="sidebar-empty-title">{L.noTodos}</div>
                <div className="sidebar-empty-sub">{EMPTY_SUB[view]}</div>
              </div>
            ) : (
              <ul
                className="resource-rows"
                role="listbox"
                aria-label={`${VIEW_LABELS[view]} ${L.todos.toLowerCase()}`}
                aria-activedescendant={listNavigation.activeDescendant}
                data-hotkey-zone={SELECTABLE_LIST_ZONE}
                tabIndex={0}
                ref={listNavigation.setListElement}
              >
                {rows.map((todo) => (
                  <li
                    key={todo.id}
                    id={listNavigation.rowId(todo.id)}
                    ref={(element) => listNavigation.setRowElement(todo.id, element)}
                    role="option"
                    aria-selected={todo.id === selectedId}
                    onClick={() => listNavigation.selectItem(todo.id)}
                  >
                    <TodoRow
                      todo={todo}
                      today={today}
                      active={todo.id === selectedId}
                      onToggleComplete={() => void update(todo.id, { completed: !todo.completed })}
                      onToggleImportant={() =>
                        void update(todo.id, {
                          importance: todo.importance === "high" ? "normal" : "high",
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="module-detail">
          {selected ? (
            <TodoDetail
              key={selected.id}
              todo={selected}
              today={today}
              threadTitles={threadTitles}
              onUpdate={(patch) => update(selected.id, patch)}
              onDelete={async () => {
                await onDelete(selected.id);
                setSelectedId(null);
              }}
              onUnlinkThread={async (threadId) => {
                try {
                  await onUnlinkThread(selected.id, threadId);
                } catch (error) {
                  report("Could not unlink conversation", error);
                }
              }}
              onOpenThread={onOpenThread}
              {...(isMobile ? { onBack: () => setSelectedId(null) } : {})}
            />
          ) : (
            <div className="module-detail-empty">
              <ListTodo size={40} strokeWidth={1} />
              <p>Select a {L.todo.toLowerCase()} to see its details, or add a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TodoRow({
  todo,
  today,
  active,
  onToggleComplete,
  onToggleImportant,
}: {
  todo: Todo;
  today: string;
  active: boolean;
  onToggleComplete: () => void;
  onToggleImportant: () => void;
}) {
  const progress = stepProgress(todo);
  const important = todo.importance === "high";
  const hasMeta = todo.dueDate !== undefined || progress !== undefined || todo.threadIds.length > 0;
  return (
    <div className={`resource-row todo-row${active ? " active" : ""}${todo.completed ? " completed" : ""}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={todo.completed}
        aria-label={todo.completed ? `Mark “${todo.title}” not completed` : `Complete “${todo.title}”`}
        className="todo-check"
        onClick={(event) => {
          event.stopPropagation();
          onToggleComplete();
        }}
      >
        {todo.completed ? <CircleCheck size={18} /> : <Circle size={18} />}
      </button>
      <span className="resource-row-main">
        <span className="resource-row-name todo-row-title">{todo.title}</span>
        {hasMeta && (
          <span className="todo-row-meta">
            {todo.dueDate !== undefined && (
              <span className={`todo-due${isOverdue(todo, today) ? " overdue" : ""}`}>
                <CalendarDays size={12} aria-hidden="true" />
                {dueLabel(todo.dueDate, today)}
              </span>
            )}
            {progress && (
              <span className="todo-steps-progress">
                {progress.done} of {progress.total}
              </span>
            )}
            {todo.threadIds.length > 0 && (
              <span
                className="todo-linked"
                title={`${todo.threadIds.length} linked conversation${todo.threadIds.length === 1 ? "" : "s"}`}
              >
                <MessageSquare size={12} aria-hidden="true" />
                {todo.threadIds.length}
              </span>
            )}
          </span>
        )}
      </span>
      <button
        type="button"
        className={`todo-star${important ? " active" : ""}`}
        aria-pressed={important}
        aria-label={important ? `Remove importance from “${todo.title}”` : `Mark “${todo.title}” important`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleImportant();
        }}
      >
        <Star size={16} fill={important ? "currentColor" : "none"} />
      </button>
    </div>
  );
}
