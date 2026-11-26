import type { RunStatus } from "./protocol-types.js";

export type TriggerKind = "cron" | "webhook";

export interface TriggerDef {
  id: string;
  kind: TriggerKind;
  name?: string;
  prompt?: string;
  /** Runs this graph instead of starting a conversation with `prompt`. */
  graphId?: string;
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
  /** Paused for a person; not replayed on restart. */
  | "waiting"
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
  /** A webhook body for a graph trigger, delivered as `input.body`. */
  inputOverride?: unknown;
  threadId?: string;
  runId?: string;
  runStatus?: RunStatus;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
