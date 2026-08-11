import { useMemo, useState } from "react";
import type { TriggerDef, TriggerKind } from "@pizza-bot/core";
import { Copy, RefreshCw, ChevronLeft, Trash2 } from "lucide-react";
import { L } from "../../lexicon.js";
import {
  CRON_PRESETS,
  describeCron,
  formatCronRun,
  nextCronRun,
  parseCron,
} from "../../lib/cron.js";
import { useAppToast } from "../AppToast.js";
import {
  WEBHOOK_SECRET_PLACEHOLDER,
  curlWebhookSecret,
  initialWebhookSecret,
} from "./webhook-secret.js";
import { CapabilityEnablement } from "../CapabilityControls.js";

export interface ScheduleEditorProps {
  kind: Extract<TriggerKind, "cron" | "webhook">;
  apiBase: string;
  defaultTimezone?: string;
  trigger: TriggerDef | null;
  onSave: (patch: Partial<TriggerDef>) => Promise<void>;
  onEnabledChange?: (enabled: boolean) => Promise<void>;
  onDelete?: () => void;
  onCancel: () => void;
}

function freshSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function ScheduleEditor({
  kind,
  apiBase,
  defaultTimezone,
  trigger,
  onSave,
  onEnabledChange,
  onDelete,
  onCancel,
}: ScheduleEditorProps) {
  const notify = useAppToast();
  const isNew = trigger === null;
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [prompt, setPrompt] = useState(trigger?.prompt ?? "");
  const [cron, setCron] = useState(trigger?.cron ?? "0 9 * * *");
  const [webhookSecret, setWebhookSecret] = useState(() =>
    initialWebhookSecret(kind, trigger, freshSecret),
  );
  const [webhookSecretDirty, setWebhookSecretDirty] = useState(
    kind === "webhook" && isNew,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronValid = useMemo(() => (kind === "cron" ? parseCron(cron) !== null : true), [kind, cron]);
  const effectiveTimezone = trigger?.timezone ?? defaultTimezone;
  const nextRun = useMemo(
    () => (kind === "cron" && cronValid ? nextCronRun(cron, new Date(), effectiveTimezone) : null),
    [kind, cron, cronValid, effectiveTimezone],
  );

  const webhookInvokeUrl = useMemo(() => {
    if (kind !== "webhook" || !trigger?.id) return null;
    const base = apiBase.startsWith("http")
      ? apiBase
      : `${typeof window !== "undefined" ? window.location.origin : ""}${apiBase}`;
    return `${base.replace(/\/$/, "")}/triggers/${trigger.id}/invoke`;
  }, [kind, trigger?.id, apiBase]);

  const curlExample = useMemo(() => {
    if (!webhookInvokeUrl) return null;
    const secret = curlWebhookSecret(webhookSecret, webhookSecretDirty);
    return [
      `curl -X POST ${webhookInvokeUrl} \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'X-Trigger-Secret: ${secret}' \\`,
      `  -d '{"prompt": "What should the agent do?"}'`,
    ].join("\n");
  }, [webhookInvokeUrl, webhookSecret, webhookSecretDirty]);

  const noun = kind === "cron" ? L.schedule : L.webhook;

  const promptValid = kind !== "cron" || prompt.trim().length > 0;
  const webhookSecretValid =
    kind !== "webhook" ||
    (!isNew && !webhookSecretDirty) ||
    webhookSecret.length >= 16;
  const canSave = cronValid && promptValid && webhookSecretValid;
  const hasStoredWebhookSecret =
    kind === "webhook" && Boolean(trigger?.hasWebhookSecret || trigger?.webhookSecret);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const patch: Partial<TriggerDef> = {
      kind,
      ...(isNew ? { enabled } : {}),
      prompt: prompt.trim() ? prompt.trim() : undefined,
      ...(kind === "cron" ? { cron } : {}),
      ...(kind === "webhook" && (isNew || webhookSecretDirty) ? { webhookSecret } : {}),
    };
    try {
      await onSave(patch);
      setWebhookSecretDirty(false);
      notify({
        title: `${kind === "cron" ? "Schedule" : "Webhook"} ${isNew ? "created" : "saved"}`,
        tone: "success",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      notify({
        title: `Could not save ${kind === "cron" ? "schedule" : "webhook"}`,
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="schedule-editor">
      <button className="module-detail-back" onClick={onCancel}>
        <ChevronLeft size={18} /> {kind === "cron" ? L.schedulesSection : L.webhooksSection}
      </button>
      <header className="schedule-editor-head">
        <h2 className="schedule-editor-title">
          {isNew
            ? `New ${noun.toLowerCase()}`
            : `Edit ${noun.toLowerCase()}`}
        </h2>
      </header>

      <div className="schedule-editor-body">
        {!isNew && onEnabledChange && (
          <CapabilityEnablement
            enabled={trigger.enabled}
            noun={noun}
            onChange={onEnabledChange}
          />
        )}

        {kind === "cron" && (
          <label className="field">
            <span className="field-label">Cron expression</span>
            <input
              className={`field-input mono${cronValid ? "" : " invalid"}`}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * *"
              spellCheck={false}
            />
            <span className={`field-hint${cronValid ? "" : " error"}`}>
              {cronValid
                ? `${describeCron(cron)}${
                    nextRun ? ` · next ~${formatCronRun(nextRun, effectiveTimezone)}` : ""
                  }${effectiveTimezone ? ` · ${effectiveTimezone}` : ""}`
                : "Not a valid 5-field cron expression."}
            </span>
            <div className="cron-presets">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  className="cron-preset"
                  onClick={() => setCron(p.cron)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </label>
        )}

        {kind === "webhook" && (
          <label className="field">
            <span className="field-label">Webhook secret</span>
            <div className="field-inline">
              <input
                className="field-input mono"
                value={webhookSecret}
                placeholder={hasStoredWebhookSecret ? "Stored secret is hidden" : undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  setWebhookSecret(value);
                  setWebhookSecretDirty(isNew || value.length > 0);
                }}
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-btn"
                title="Regenerate secret"
                onClick={() => {
                  setWebhookSecret(freshSecret());
                  setWebhookSecretDirty(true);
                }}
              >
                <RefreshCw size={15} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Copy secret"
                onClick={() => void navigator.clipboard?.writeText(webhookSecret)}
                disabled={!webhookSecret}
              >
                <Copy size={15} />
              </button>
            </div>
            <span
              className={`field-hint${
                webhookSecretDirty || !webhookSecretValid ? " warn" : ""
              }`}
            >
              {!webhookSecretValid
                ? "Webhook secrets must be at least 16 characters."
                : webhookSecretDirty
                  ? "Save changes to activate this replacement secret."
                  : !webhookSecret && hasStoredWebhookSecret
                    ? "The stored secret cannot be shown. Use your saved copy, or regenerate and save a replacement."
                    : <>Send as <code>X-Trigger-Secret</code> or <code>Authorization: Bearer …</code> when POSTing to fire this webhook.</>}
            </span>
          </label>
        )}

        {kind === "webhook" && (
          <div className="field">
            <span className="field-label">How to trigger</span>
            {webhookInvokeUrl && curlExample ? (
              <>
                <div className="field-inline">
                  <input className="field-input mono" value={webhookInvokeUrl} readOnly spellCheck={false} />
                  <button
                    type="button"
                    className="icon-btn"
                    title="Copy URL"
                    onClick={() => void navigator.clipboard?.writeText(webhookInvokeUrl)}
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <div className="webhook-curl">
                  <pre className="webhook-curl-code">{curlExample}</pre>
                  <button
                    type="button"
                    className="icon-btn webhook-curl-copy"
                    title="Copy curl command"
                    onClick={() => void navigator.clipboard?.writeText(curlExample)}
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <span className="field-hint">
                  {webhookSecretDirty ? (
                    "Save the replacement secret before using this sample request."
                  ) : webhookSecret ? (
                    <>POST to fire it. The <code>prompt</code> in the body becomes the agent’s task
                    (<code>text</code> or a raw JSON string also work).</>
                  ) : (
                    <>Replace <code>{WEBHOOK_SECRET_PLACEHOLDER}</code> with the webhook’s saved secret.</>
                  )}
                </span>
              </>
            ) : (
              <span className="field-hint">Save this webhook to get its invoke URL and a sample request.</span>
            )}
          </div>
        )}

        <label className="field">
          <span className="field-label">
            Seed prompt
            {kind === "webhook" && <span className="field-optional"> (optional)</span>}
          </span>
          <textarea
            className={`field-input${promptValid ? "" : " invalid"}`}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do when this fires?"
            required={kind === "cron"}
            aria-invalid={!promptValid}
          />
          {kind === "cron" && !promptValid && (
            <span className="field-hint error">A seed prompt is required for scheduled runs.</span>
          )}
          {kind === "webhook" && (
            <span className={`field-hint${prompt.trim() ? "" : " warn"}`}>
              {prompt.trim()
                ? "Used when the POST body doesn’t include a prompt."
                : "No seed prompt — the POST body must include a prompt (e.g. {\"prompt\": \"…\"}), or the run will have no task to perform."}
            </span>
          )}
        </label>

        {isNew && (
          <label className="field field-checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
        )}

        {error && <div className="schedule-editor-error">{error}</div>}
      </div>

      <footer className="resource-editor-actions">
        {!isNew && onDelete && (
          <button
            type="button"
            className="btn-secondary resource-editor-delete"
            onClick={onDelete}
            disabled={saving}
          >
            <Trash2 size={14} /> Delete
          </button>
        )}
        <span className="resource-editor-actions-spacer" />
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={!canSave || saving}>
          {saving ? "Saving…" : isNew ? "Create" : "Save"}
        </button>
      </footer>
    </div>
  );
}
