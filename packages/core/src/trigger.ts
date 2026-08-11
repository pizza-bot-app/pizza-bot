import type { RunStatus } from "./protocol-types.js";

export type TriggerKind = "cron" | "webhook";

export interface TriggerDef {
  id: string;
  kind: TriggerKind;
  prompt?: string;
  enabled: boolean;
  cron?: string;
  timezone?: string;
  /** Write-only on create/update. Read models expose `hasWebhookSecret`. */
  webhookSecret?: string;
  hasWebhookSecret?: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastThreadId?: string;
}

export type TriggerOccurrenceReason = "cron" | "cron-recovery" | "manual" | "webhook";

export type TriggerOccurrenceStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "dead";

export interface TriggerOccurrence {
  id: string;
  triggerId: string;
  scheduledAt: string;
  reason: TriggerOccurrenceReason;
  status: TriggerOccurrenceStatus;
  /** Crash-recovery budget: each (re)launch increments it; exhausting it kills the occurrence. */
  attempt: number;
  promptOverride?: string;
  threadId?: string;
  runId?: string;
  runStatus?: RunStatus;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
