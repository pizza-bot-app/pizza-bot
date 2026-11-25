/** Advanced JSON merged into every chat request a provider sends. */
import type { ProviderAuthField } from "@pizza-bot/core";

export const REQUEST_OVERRIDES_FIELD: ProviderAuthField = {
  key: "requestOverrides",
  label: "Advanced request JSON",
  type: "json",
  required: false,
};

// Integrations spread raw request fields after their own, so these would
// silently replace the agent's model, transcript, tools, or streaming mode.
const RESERVED_KEYS = new Set([
  "model",
  "messages",
  "input",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "stream",
  "stream_options",
  "n",
]);

// The output-token budget field owns the cap, and Chat Completions re-sets it after raw fields anyway.
const OUTPUT_CAP_KEYS = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens"]);

export type RequestOverrides = Record<string, unknown>;

/** Throws a message fit for the settings form; blank input means no overrides. */
export function parseRequestOverrides(raw: string | undefined): RequestOverrides | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Advanced request JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Advanced request JSON must be an object, such as {\"service_tier\": \"flex\"}.");
  }
  const reserved = Object.keys(parsed).filter((key) => RESERVED_KEYS.has(key));
  if (reserved.length > 0) {
    throw new Error(
      `Advanced request JSON cannot set ${reserved.map((key) => `"${key}"`).join(", ")}; Pizza Bot controls those fields.`,
    );
  }
  const caps = Object.keys(parsed).filter((key) => OUTPUT_CAP_KEYS.has(key));
  if (caps.length > 0) {
    throw new Error(
      `Advanced request JSON cannot set ${caps.map((key) => `"${key}"`).join(", ")}; use the output token budget field.`,
    );
  }
  return Object.keys(parsed).length > 0 ? (parsed as RequestOverrides) : undefined;
}
