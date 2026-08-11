import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Pencil } from "lucide-react";

export function ChatHeader({
  title,
  onRename,
  onBack,
  actions,
}: {
  title: string;
  onRename?: (title: string) => Promise<void>;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [renameFailed, setRenameFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    setDraft(title);
    setRenameFailed(false);
    setEditing(true);
  };

  const cancelEditing = () => {
    savingRef.current = false;
    setDraft(title);
    setRenameFailed(false);
    setEditing(false);
  };

  const saveTitle = async () => {
    if (!onRename || savingRef.current) return;
    const nextTitle = draft.trim();
    if (!nextTitle || nextTitle === title) {
      cancelEditing();
      return;
    }

    savingRef.current = true;
    setRenameFailed(false);
    try {
      await onRename(nextTitle);
      setEditing(false);
    } catch (error) {
      console.error("rename failed", error);
      setRenameFailed(true);
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <header className="chat-header">
      {onBack && (
        <button className="chat-header-back" onClick={onBack} aria-label="Back to conversations">
          <ChevronLeft size={22} />
        </button>
      )}
      <div className="chat-header-text">
        {editing ? (
          <input
            ref={inputRef}
            className={`chat-header-title-input${renameFailed ? " error" : ""}`}
            value={draft}
            aria-label="Conversation title"
            aria-invalid={renameFailed}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveTitle();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
              }
            }}
            onBlur={() => void saveTitle()}
          />
        ) : onRename ? (
          <button
            type="button"
            className="chat-header-title chat-header-title-button"
            aria-label={`Rename conversation: ${title}`}
            title="Rename conversation"
            onClick={startEditing}
          >
            <span className="chat-header-title-label">{title}</span>
            <Pencil className="chat-header-title-edit" size={14} />
          </button>
        ) : (
          <div className="chat-header-title">
            <span className="chat-header-title-label">{title}</span>
          </div>
        )}
      </div>
      {actions && <div className="chat-header-actions">{actions}</div>}
    </header>
  );
}
