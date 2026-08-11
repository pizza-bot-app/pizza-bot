import { Dialog as DialogPrimitive } from "radix-ui";

export interface ConfirmationDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmationDialog({
  title,
  message,
  confirmLabel,
  destructive = false,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content
          className="sidebar-modal"
          aria-busy={busy}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || busy) return;
            event.preventDefault();
            event.stopPropagation();
            onConfirm();
          }}
        >
          <DialogPrimitive.Title className="sidebar-modal-title">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sidebar-modal-body">
            {message}
          </DialogPrimitive.Description>
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
              className={`sidebar-modal-btn${destructive ? " danger" : " primary"}`}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? `${confirmLabel}…` : confirmLabel}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
