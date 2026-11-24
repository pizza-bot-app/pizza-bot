import { useEffect, useMemo, useState } from "react";
import type { TriggerDef, TriggerKind } from "@pizza-bot/core";
import { CalendarClock, Webhook, Plus, Play } from "lucide-react";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { TriggerView } from "./TriggerView.js";
import { ModuleHeader } from "../ModuleHeader.js";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { useAppToast } from "../AppToast.js";
import { L } from "../../lexicon.js";
import { describeCron, formatCronRun, nextCronRun } from "../../lib/cron.js";
import { relativeTime } from "../../lib/conversation.js";
import { useIsMobile } from "../../use-is-mobile.js";
import {
  SELECTABLE_LIST_ZONE,
  useSelectableListNavigation,
} from "../../use-selectable-list-navigation.js";
import { CapabilityStatusDot } from "../CapabilityControls.js";

type HostedKind = Extract<TriggerKind, "cron" | "webhook">;

const KIND_UI: Record<HostedKind, { section: string; noun: string; empty: string; rowDetail: string }> = {
  cron: { section: L.schedulesSection, noun: L.schedule, empty: L.noSchedules, rowDetail: "" },
  webhook: { section: L.webhooksSection, noun: L.webhook, empty: L.noWebhooks, rowDetail: "inbound webhook" },
};

export interface TriggerModuleProps {
  kind: HostedKind;
  apiBase: string;
  defaultTimezone?: string;
  triggers: TriggerDef[];
  loading: boolean;
  onCreate: (def: Partial<TriggerDef>) => Promise<TriggerDef>;
  onUpdate: (id: string, patch: Partial<TriggerDef>) => Promise<TriggerDef>;
  onDelete: (id: string) => Promise<boolean>;
  onRun: (id: string) => Promise<{ threadId: string }>;
}

type Selection =
  | { mode: "view" | "edit"; id: string; revealedWebhookSecret?: string }
  | { mode: "new" }
  | null;

export function TriggerModule({
  kind,
  apiBase,
  defaultTimezone,
  triggers,
  loading,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
}: TriggerModuleProps) {
  const notify = useAppToast();
  const [selection, setSelection] = useState<Selection>(null);
  const [pendingDelete, setPendingDelete] = useState<TriggerDef | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const ui = KIND_UI[kind];
  const HeaderIcon = kind === "cron" ? CalendarClock : Webhook;
  const mobileDetailOpen = selection !== null;

  const ofKind = useMemo(() => triggers.filter((t) => t.kind === kind), [triggers, kind]);

  useEffect(() => {
    if (selection && selection.mode !== "new" && !ofKind.some((t) => t.id === selection.id)) {
      setSelection(null);
    }
  }, [ofKind, selection]);

  const selectedId = selection && selection.mode !== "new" ? selection.id : null;
  const revealedWebhookSecret =
    selection && selection.mode !== "new" ? selection.revealedWebhookSecret : undefined;
  const storedSelectedTrigger = selectedId ? ofKind.find((t) => t.id === selectedId) ?? null : null;
  const selectedTrigger =
    storedSelectedTrigger && revealedWebhookSecret
      ? { ...storedSelectedTrigger, webhookSecret: revealedWebhookSecret }
      : storedSelectedTrigger;
  const listNavigation = useSelectableListNavigation({
    itemIds: ofKind.map((trigger) => trigger.id),
    selectedId,
    onSelect: (id) => setSelection({ mode: "view", id }),
    searchEnabled: false,
  });

  const handleSave = async (patch: Partial<TriggerDef>) => {
    if (selection?.mode === "edit") {
      await onUpdate(selection.id, patch);
      setSelection({
        mode: "view",
        id: selection.id,
        ...(patch.webhookSecret ? { revealedWebhookSecret: patch.webhookSecret } : {}),
      });
    } else {
      const created = await onCreate({ ...patch, kind });
      setSelection({
        mode: "view",
        id: created.id,
        ...(patch.webhookSecret ? { revealedWebhookSecret: patch.webhookSecret } : {}),
      });
    }
  };

  const handleRun = async (t: TriggerDef) => {
    if (!t.enabled) return;
    try {
      await onRun(t.id);
      notify({ title: `${ui.noun} started`, tone: "success" });
    } catch (error) {
      notify({
        title: `${ui.noun} could not start`,
        description: error instanceof Error ? error.message : "Run failed",
        tone: "error",
      });
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const deleted = await onDelete(pendingDelete.id);
      if (!deleted) {
        setDeleteError(`This ${ui.noun.toLowerCase()} could not be deleted.`);
        return;
      }
      setPendingDelete(null);
      setSelection(null);
      notify({ title: "Delete complete", tone: "success" });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="module schedules-module">
      <ModuleHeader icon={<HeaderIcon size={18} />} title={ui.section} count={ofKind.length}>
        <span className="module-header-spacer" />
        <button className="btn-primary" onClick={() => setSelection({ mode: "new" })}>
          <Plus size={15} /> New {ui.noun}
        </button>
      </ModuleHeader>

      <div
        className={`module-body${
          isMobile ? (mobileDetailOpen ? " mobile-detail" : " mobile-list") : ""
        }`}
      >
        <div
          className="schedules-list"
          role="listbox"
          aria-label={ui.section}
          aria-activedescendant={listNavigation.activeDescendant}
          data-hotkey-zone={SELECTABLE_LIST_ZONE}
          tabIndex={0}
          ref={listNavigation.setListElement}
        >
          {loading && triggers.length === 0 ? (
            <div className="sidebar-empty">
              <div className="sidebar-empty-title">Loading…</div>
            </div>
          ) : ofKind.length === 0 ? (
            <div className="sidebar-empty">
              <div className="sidebar-empty-title">{ui.empty}</div>
              <div className="sidebar-empty-sub">
                {kind === "cron"
                  ? "Create one to run Pizza Bot on a schedule."
                  : "Create one to run Pizza Bot from an inbound HTTP request."}
              </div>
            </div>
          ) : (
            <ul className="schedules-rows">
              {ofKind.map((t) => {
                      const effectiveTimezone = t.timezone ?? defaultTimezone;
                      const next =
                        kind === "cron" && t.cron
                          ? nextCronRun(t.cron, new Date(), effectiveTimezone)
                          : null;
                      const active = selectedId === t.id;
                      return (
                        <li
                          key={t.id}
                          id={listNavigation.rowId(t.id)}
                          ref={(element) => listNavigation.setRowElement(t.id, element)}
                          role="option"
                          aria-selected={active}
                          onClick={() => listNavigation.selectItem(t.id)}
                        >
                          <div
                            className={`schedule-row${active ? " active" : ""}${t.enabled ? "" : " disabled"}`}
                          >
                            <span className="schedule-row-main">
                              <span className="schedule-row-line1">
                                <span className="schedule-row-detail">
                                  {kind === "cron"
                                    ? t.cron
                                      ? describeCron(t.cron)
                                      : "no expression"
                                    : ui.rowDetail}
                                </span>
                                <CapabilityStatusDot
                                  state={t.enabled ? "active" : "disabled"}
                                  label={t.enabled ? "Enabled" : "Disabled"}
                                />
                              </span>
                              <span className="schedule-row-line2">
                                {next && (
                                  <span>Next {formatCronRun(next, effectiveTimezone)}</span>
                                )}
                                <span>
                                  {t.lastRunAt ? `Last ran ${relativeTime(t.lastRunAt)}` : "Never run"}
                                </span>
                              </span>
                            </span>
                            <span className="schedule-row-actions">
                              {t.enabled && (
                                <button
                                  className="thread-action"
                                  aria-label="Run now"
                                  title={`Run this ${ui.noun.toLowerCase()} now`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleRun(t);
                                  }}
                                >
                                  <Play size={14} />
                                </button>
                              )}
                            </span>
                          </div>
                        </li>
                      );
              })}
            </ul>
          )}
        </div>

        <div className="module-detail">
          {selection?.mode === "view" && selectedTrigger ? (
            <TriggerView
              trigger={selectedTrigger}
              apiBase={apiBase}
              defaultTimezone={defaultTimezone}
              revealedWebhookSecret={revealedWebhookSecret}
              onEnabledChange={async (enabled) => {
                await onUpdate(selectedTrigger.id, { enabled });
              }}
              onRun={() => void handleRun(selectedTrigger)}
              onEdit={() => setSelection({ mode: "edit", id: selectedTrigger.id })}
              onBack={() => setSelection(null)}
            />
          ) : selection?.mode === "new" || (selection?.mode === "edit" && selectedTrigger) ? (
            <ScheduleEditor
              // Remount for a new selection, not for each fresh object from polling.
              key={selection.mode === "edit" ? selection.id : "new"}
              kind={kind}
              defaultTimezone={defaultTimezone}
              trigger={selection.mode === "edit" ? selectedTrigger : null}
              onSave={handleSave}
              onDelete={
                selectedTrigger
                  ? () => {
                      setDeleteError(null);
                      setPendingDelete(selectedTrigger);
                    }
                  : undefined
              }
              onCancel={() =>
                setSelection(selectedId ? { mode: "view", id: selectedId } : null)
              }
            />
          ) : (
            <div className="module-detail-empty">
              <HeaderIcon size={40} strokeWidth={1} />
              <p>Select a {ui.noun.toLowerCase()} to see it, or create a new one.</p>
            </div>
          )}
        </div>
      </div>

      {pendingDelete && (
        <ConfirmationDialog
          title={`Delete ${ui.noun.toLowerCase()}?`}
          message={`This ${ui.noun.toLowerCase()} will be permanently deleted. This can’t be undone.`}
          confirmLabel="Delete"
          destructive
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
          onConfirm={() => void handleDelete()}
        />
      )}
    </div>
  );
}
