import type { TodoEvent } from "@pizza-bot/core";
import {
  AlarmClock,
  CircleAlert,
  CirclePause,
  ListTree,
  CircleCheck,
  Forward,
  History,
  Mail,
  MessageCircleQuestion,
  PenLine,
  RefreshCw,
  RotateCcw,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { relativeTime } from "../../lib/conversation.js";
import { todoTimeline, type TimelineEntry } from "../../lib/todo-ownership.js";
import { L } from "../../lexicon.js";

const ICONS: Record<TodoEvent["kind"], LucideIcon> = {
  assigned: UserPlus,
  unassigned: UserMinus,
  "check-in": RefreshCw,
  progress: PenLine,
  completed: CircleCheck,
  reopened: RotateCcw,
  notified: Mail,
  asked: MessageCircleQuestion,
  failed: CircleAlert,
  snoozed: AlarmClock,
  subtask: ListTree,
  paused: CirclePause,
};

export function TodoTimeline({
  history,
  nameOf,
  onOpenThread,
  onOpenTodo,
}: {
  history: readonly TodoEvent[];
  nameOf: (agentId: string) => string;
  onOpenThread: (entry: TimelineEntry & { threadId: string }) => void;
  onOpenTodo?: (todoId: string) => void;
}) {
  if (history.length === 0) return null;
  const entries = todoTimeline(history, nameOf);
  const handoffs = new Set(history.filter((e) => e.kind === "assigned" && e.actor !== "user").map((e) => e.id));
  return (
    <section className="todo-detail-section">
      <h3 className="todo-detail-section-title">
        <History size={14} /> {L.todoTimeline}
      </h3>
      <ol className="todo-timeline">
        {entries.map((entry) => {
          const Icon = handoffs.has(entry.id) ? Forward : ICONS[entry.kind];
          return (
            <li key={entry.id} className={`todo-timeline-entry kind-${entry.kind}`}>
              <Icon size={14} aria-hidden="true" className="todo-timeline-icon" />
              <span className="todo-timeline-text">
                {entry.todoId && onOpenTodo ? (
                  <button
                    type="button"
                    className="todo-timeline-link"
                    onClick={() => onOpenTodo(entry.todoId!)}
                  >
                    {entry.text}
                  </button>
                ) : entry.threadId ? (
                  <button
                    type="button"
                    className="todo-timeline-link"
                    onClick={() => onOpenThread(entry as TimelineEntry & { threadId: string })}
                  >
                    {entry.text}
                  </button>
                ) : (
                  entry.text
                )}
              </span>
              <time className="todo-timeline-time" dateTime={entry.at} title={entry.at}>
                {relativeTime(entry.at)}
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
