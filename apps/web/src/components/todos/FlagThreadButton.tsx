import { useState } from "react";
import type { Todo } from "@pizza-bot/core";
import { errorMessage } from "@/api-client";
import { Flag } from "lucide-react";
import { useAppToast } from "../AppToast.js";
import { L } from "../../lexicon.js";

export interface FlagThreadButtonProps {
  /** The incomplete Todo already linked to this thread, if any. */
  todo: Todo | undefined;
  compact?: boolean;
  onFlag: () => Promise<unknown>;
  onOpenTodo: (todoId: string) => void;
}

export function FlagThreadButton({ todo, compact = false, onFlag, onOpenTodo }: FlagThreadButtonProps) {
  const notify = useAppToast();
  const [busy, setBusy] = useState(false);
  const label = todo ? L.flaggedThread : L.flagThread;

  const flag = async () => {
    setBusy(true);
    try {
      await onFlag();
      notify({ title: `Added to ${L.todosSection}`, tone: "success" });
    } catch (error) {
      notify({ title: "Could not add to Todos", description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`rail-toggle todo-flag${todo ? " active" : ""}${compact ? " icon-only" : ""}`}
      title={todo ? `Open “${todo.title}” in ${L.todosSection}` : label}
      aria-label={todo ? `${label}: open “${todo.title}”` : label}
      aria-pressed={todo !== undefined}
      disabled={busy}
      onClick={() => (todo ? onOpenTodo(todo.id) : void flag())}
    >
      <Flag size={compact ? 16 : 15} fill={todo ? "currentColor" : "none"} />
      {!compact && label}
    </button>
  );
}
