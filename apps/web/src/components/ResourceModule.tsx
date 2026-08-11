import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { ModuleHeader } from "./ModuleHeader.js";
import { useIsMobile } from "../use-is-mobile.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { useAppToast } from "./AppToast.js";

export type ResourceSelection = { mode: "view"; id: string } | { mode: "new" } | null;

export interface ResourceDetailArgs<T> {
  selection: ResourceSelection;
  selected: T | null;
  setSelection: (next: ResourceSelection) => void;
  backToList?: () => void;
  confirmAction: (
    message: string,
    action: () => Promise<unknown>,
    options: {
      title: string;
      confirmLabel: string;
      destructive?: boolean;
      preserveSelection?: boolean;
    },
  ) => Promise<void>;
}

interface PendingConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: boolean;
  preserveSelection: boolean;
  action: () => Promise<unknown>;
  resolve: () => void;
}

export interface ResourceModuleProps<T> {
  items: T[];
  getId: (item: T) => string;
  icon: ReactNode;
  emptyIcon: ReactNode;
  title: string;
  newLabel: string;
  emptyText: ReactNode;
  canCreate?: boolean;
  renderHeaderActions?: (args: { setSelection: (next: ResourceSelection) => void }) => ReactNode;
  moduleClassName?: string;
  renderList: (args: { selectedId: string | null; onSelect: (id: string) => void }) => ReactNode;
  renderDetail: (args: ResourceDetailArgs<T>) => ReactNode;
}

export function initialResourceSelection<T>(
  selection: ResourceSelection,
  items: T[],
  getId: (item: T) => string,
  isMobile: boolean,
): ResourceSelection {
  if (selection !== null || isMobile || items.length === 0) return selection;
  return { mode: "view", id: getId(items[0]!) };
}

export function ResourceModule<T>({
  items,
  getId,
  icon,
  emptyIcon,
  title,
  newLabel,
  emptyText,
  canCreate = true,
  renderHeaderActions,
  moduleClassName = "module resource-module",
  renderList,
  renderDetail,
}: ResourceModuleProps<T>) {
  const notify = useAppToast();
  const [selection, setSelection] = useState<ResourceSelection>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const confirmationInFlight = useRef(false);
  const isMobile = useIsMobile();
  const mobileDetailOpen = selection !== null;

  useEffect(() => {
    const initial = initialResourceSelection(selection, items, getId, isMobile);
    if (initial !== selection) setSelection(initial);
  }, [items, selection, getId, isMobile]);

  const selectedId = selection?.mode === "view" ? selection.id : null;
  const selected = items.find((item) => getId(item) === selectedId) ?? null;

  const confirmAction = (
    message: string,
    action: () => Promise<unknown>,
    options: {
      title: string;
      confirmLabel: string;
      destructive?: boolean;
      preserveSelection?: boolean;
    },
  ): Promise<void> => {
    setConfirmationError(null);
    return new Promise((resolve) => {
      setConfirmation({
        title: options.title,
        message,
        confirmLabel: options.confirmLabel,
        destructive: options.destructive ?? false,
        preserveSelection: options.preserveSelection ?? false,
        action,
        resolve,
      });
    });
  };

  const backToList = isMobile ? () => setSelection(null) : undefined;

  const detail = renderDetail({ selection, selected, setSelection, backToList, confirmAction });

  const cancelConfirmation = () => {
    if (confirming) return;
    confirmation?.resolve();
    setConfirmation(null);
    setConfirmationError(null);
  };

  const runConfirmedAction = async () => {
    if (!confirmation || confirmationInFlight.current) return;
    confirmationInFlight.current = true;
    setConfirming(true);
    setConfirmationError(null);
    try {
      await confirmation.action();
      if (!confirmation.preserveSelection) setSelection(null);
      confirmation.resolve();
      notify({ title: `${confirmation.confirmLabel} complete`, tone: "success" });
      setConfirmation(null);
    } catch (cause) {
      setConfirmationError(
        cause instanceof Error ? cause.message : "The action could not be completed.",
      );
    } finally {
      confirmationInFlight.current = false;
      setConfirming(false);
    }
  };

  return (
    <>
      <div className={moduleClassName}>
        <ModuleHeader icon={icon} title={title} count={items.length}>
          <span className="module-header-spacer" />
          {renderHeaderActions?.({ setSelection })}
          {canCreate && (
            <button className="btn-primary" onClick={() => setSelection({ mode: "new" })}>
              <Plus size={15} /> {newLabel}
            </button>
          )}
        </ModuleHeader>
        <div
          className={`module-body${
            isMobile ? (mobileDetailOpen ? " mobile-detail" : " mobile-list") : ""
          }`}
        >
          {renderList({ selectedId, onSelect: (id) => setSelection({ mode: "view", id }) })}
          <div className="module-detail">
            {detail ?? (
              <div className="module-detail-empty">
                {emptyIcon}
                <p>{emptyText}</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmation && (
        <ConfirmationDialog
          title={confirmation.title}
          message={confirmation.message}
          confirmLabel={confirmation.confirmLabel}
          destructive={confirmation.destructive}
          busy={confirming}
          error={confirmationError}
          onCancel={cancelConfirmation}
          onConfirm={() => void runConfirmedAction()}
        />
      )}
    </>
  );
}
