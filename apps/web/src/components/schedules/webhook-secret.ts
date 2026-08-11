import type { TriggerDef, TriggerKind } from "@pizza-bot/core";

export const WEBHOOK_SECRET_PLACEHOLDER = "<webhook-secret>";

export function initialWebhookSecret(
  kind: TriggerKind,
  trigger: TriggerDef | null,
  generate: () => string,
): string {
  if (kind !== "webhook") return "";
  if (trigger?.webhookSecret) return trigger.webhookSecret;
  return trigger === null ? generate() : "";
}

export function curlWebhookSecret(secret: string, dirty: boolean): string {
  return secret && !dirty ? secret : WEBHOOK_SECRET_PLACEHOLDER;
}
