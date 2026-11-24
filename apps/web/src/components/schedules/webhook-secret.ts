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

export function webhookInvokeUrl(apiBase: string, triggerId: string): string {
  const base = apiBase.startsWith("http")
    ? apiBase
    : `${typeof window !== "undefined" ? window.location.origin : ""}${apiBase}`;
  return `${base.replace(/\/$/, "")}/triggers/${triggerId}/invoke`;
}

export function webhookCurlExample(invokeUrl: string, secret: string): string {
  return [
    `curl -X POST ${invokeUrl} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'X-Trigger-Secret: ${secret}' \\`,
    `  -d '{"prompt": "What should the agent do?"}'`,
  ].join("\n");
}
