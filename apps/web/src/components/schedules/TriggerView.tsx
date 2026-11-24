import type { TriggerDef } from "@pizza-bot/core";
import { CalendarClock, Copy, MessageSquareText, Play, Webhook } from "lucide-react";
import { CapabilityEnablement, CapabilityStatusDot } from "../CapabilityControls.js";
import { EditAction, ResourceSection, ResourceView } from "../ResourceView.js";
import { L } from "../../lexicon.js";
import { triggerLabel } from "./trigger-label.js";
import { describeCron, formatCronRun, nextCronRun } from "../../lib/cron.js";
import { relativeTime } from "../../lib/conversation.js";
import {
  WEBHOOK_SECRET_PLACEHOLDER,
  webhookCurlExample,
  webhookInvokeUrl,
} from "./webhook-secret.js";

export function TriggerView({
  trigger,
  apiBase,
  defaultTimezone,
  revealedWebhookSecret,
  onEnabledChange,
  onRun,
  onEdit,
  onBack,
}: {
  trigger: TriggerDef;
  apiBase: string;
  defaultTimezone?: string;
  revealedWebhookSecret?: string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onRun: () => void;
  onEdit: () => void;
  onBack: () => void;
}) {
  const isCron = trigger.kind === "cron";
  const noun = isCron ? L.schedule : L.webhook;
  const timezone = trigger.timezone ?? defaultTimezone;
  const next = isCron && trigger.cron ? nextCronRun(trigger.cron, new Date(), timezone) : null;
  const lastRun = trigger.lastRunAt ? `Last ran ${relativeTime(trigger.lastRunAt)}` : "Never run";
  const invokeUrl = isCron ? null : webhookInvokeUrl(apiBase, trigger.id);
  const curl = invokeUrl
    ? webhookCurlExample(invokeUrl, revealedWebhookSecret ?? WEBHOOK_SECRET_PLACEHOLDER)
    : null;

  return (
    <ResourceView
      glyph={isCron ? <CalendarClock size={28} strokeWidth={1.5} /> : <Webhook size={28} strokeWidth={1.5} />}
      name={triggerLabel(trigger)}
      status={
        <>
          <CapabilityStatusDot
            state={trigger.enabled ? "active" : "disabled"}
            label={trigger.enabled ? "Enabled" : "Disabled"}
          />{" "}
          {[trigger.enabled ? "Enabled" : "Disabled", next && `Next ${formatCronRun(next, timezone)}`, lastRun]
            .filter(Boolean)
            .join(" · ")}
        </>
      }
      provenance={
        isCron ? (
          <span>
            {trigger.name && trigger.cron ? `${describeCron(trigger.cron)} · ` : ""}
            <code>{trigger.cron}</code>
            {timezone ? ` · ${timezone}` : ""}
          </span>
        ) : (
          <code>{trigger.id}</code>
        )
      }
      headerAction={<EditAction onEdit={onEdit} />}
      backLabel={isCron ? L.schedulesSection : L.webhooksSection}
      onBack={onBack}
    >
      <CapabilityEnablement enabled={trigger.enabled} noun={noun} onChange={onEnabledChange} />
      <section className="resource-inline-action">
        <div className="resource-inline-action-copy">
          <div className="resource-inline-action-title">Run now</div>
          <div className="resource-inline-action-detail">
            {trigger.enabled
              ? `Start a conversation from this ${noun.toLowerCase()} immediately.`
              : `Enable this ${noun.toLowerCase()} to run it.`}
          </div>
        </div>
        <button type="button" className="btn-secondary" onClick={onRun} disabled={!trigger.enabled}>
          <Play size={14} /> Run now
        </button>
      </section>
      <ResourceSection title="Seed prompt" icon={<MessageSquareText size={14} />}>
        {trigger.prompt ? (
          <pre className="skill-card-body">{trigger.prompt}</pre>
        ) : (
          <p className="resource-card-empty">
            No seed prompt. The request body must include a <code>prompt</code>.
          </p>
        )}
      </ResourceSection>
      {invokeUrl && curl && (
        <ResourceSection
          title="How to trigger"
          icon={<Webhook size={14} />}
          aside={
            <button
              type="button"
              className="icon-btn"
              title="Copy curl command"
              onClick={() => void navigator.clipboard?.writeText(curl)}
            >
              <Copy size={15} />
            </button>
          }
        >
          <pre className="skill-card-body">{curl}</pre>
          <p className="resource-card-empty">
            {revealedWebhookSecret ? (
              "Copy this secret now. It won’t be shown again."
            ) : (
              <>
                Replace <code>{WEBHOOK_SECRET_PLACEHOLDER}</code> with your saved secret, or set a new one
                from Edit.
              </>
            )}
          </p>
        </ResourceSection>
      )}
    </ResourceView>
  );
}
