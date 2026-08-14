import { ERROR_CODES, type ErrorCode } from "./protocol-types.js";

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.toLowerCase();
  if (typeof err === "string") return err.toLowerCase();
  if (err && typeof err === "object") {
    const o = err as { name?: unknown; message?: unknown; code?: unknown; Code?: unknown };
    return [o.name, o.code, o.Code, o.message]
      .filter((v): v is string => typeof v === "string")
      .join(" ")
      .toLowerCase();
  }
  return String(err).toLowerCase();
}

/**
 * Specific, actionable categories take precedence over generic matches.
 * Unknown errors return `GENERAL`.
 */
export function classifyError(err: unknown): ErrorCode {
  // Provider-tagged taxonomy codes take precedence over message matching.
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) {
      return code as ErrorCode;
    }
  }

  const m = messageOf(err);

  if (
    m.includes("session has expired") ||
    m.includes("reauthenticate") ||
    m.includes("expired token") ||
    m.includes("expiredtoken") ||
    m.includes("security token") ||
    m.includes("credential provider failed") ||
    m.includes("could not load credentials") ||
    m.includes("unrecognizedclient") ||
    m.includes("not authorized") ||
    m.includes("accessdenied") ||
    m.includes("unauthorized")
  ) {
    return "AUTH_EXPIRED";
  }

  if (
    m.includes("rate limit") ||
    m.includes("ratelimit") ||
    m.includes("throttl") ||
    m.includes("too many requests") ||
    m.includes("429")
  ) {
    return "RATE_LIMIT";
  }

  if (
    m.includes("context length") ||
    m.includes("context window") ||
    (m.includes("context size") && m.includes("exceed")) ||
    m.includes("prompt is too long") ||
    m.includes("input is too long") ||
    m.includes("too many tokens") ||
    m.includes("maximum context") ||
    m.includes("exceeds the maximum")
  ) {
    return "CONTEXT_LENGTH";
  }

  if (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("etimedout") ||
    m.includes("aborterror") // Fetch/Undici deadline abort, not user cancellation.
  ) {
    return "TIMEOUT";
  }

  return "GENERAL";
}
