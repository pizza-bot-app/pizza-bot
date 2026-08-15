import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

export interface FolderNameDialogProps {
  title: string;
  confirmLabel: string;
  initialName?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

export function FolderNameDialog({
  title,
  confirmLabel,
  initialName = "",
  busy = false,
  error,
  onCancel,
  onConfirm,
}: FolderNameDialogProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content className="sidebar-modal" aria-busy={busy}>
          <DialogPrimitive.Title className="sidebar-modal-title">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Enter a folder name.
          </DialogPrimitive.Description>
          <input
            ref={inputRef}
            className="sidebar-modal-input"
            value={name}
            maxLength={80}
            disabled={busy}
            aria-label="Folder name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || busy) return;
              event.preventDefault();
              submit();
            }}
          />
          {error && (
            <div className="sidebar-modal-error" role="alert">
              {error}
            </div>
          )}
          <div className="sidebar-modal-actions">
            <DialogPrimitive.Close asChild>
              <button type="button" className="sidebar-modal-btn" disabled={busy}>
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button
              type="button"
              className="sidebar-modal-btn primary"
              disabled={busy || !name.trim()}
              onClick={submit}
            >
              {busy ? `${confirmLabel}…` : confirmLabel}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
