import type { LogError, LogValue } from "./types.js";

const SENSITIVE_KEY =
  /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|session)/i;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const URL_CREDENTIAL = /([?&](?:access_token|api_key|key|secret|token)=)[^&#\s]+/gi;
const ASSIGNMENT =
  /\b((?:api[_-]?key|password|passwd|secret|token|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const MAX_DEPTH = 8;
const MAX_STRING = 32_000;
const MAX_ARRAY = 100;
const MAX_KEYS = 100;

export interface Redactor {
  value(value: unknown, key?: string): LogValue;
  text(text: string): string;
  error(error: unknown): LogError;
}

export function createRedactor(knownSecrets: readonly string[] = []): Redactor {
  const secrets = [...new Set(knownSecrets.filter((value) => value.length >= 4))]
    .sort((a, b) => b.length - a.length);

  function text(input: string): string {
    let out = input.slice(0, MAX_STRING);
    for (const secret of secrets) out = out.split(secret).join("<redacted>");
    return out
      .replace(BEARER, "$1<redacted>")
      .replace(URL_CREDENTIAL, "$1<redacted>")
      .replace(ASSIGNMENT, "$1<redacted>");
  }

  function value(input: unknown, key?: string, depth = 0, seen = new WeakSet<object>()): LogValue {
    if (key && SENSITIVE_KEY.test(key)) return "<redacted>";
    if (input === null || input === undefined) return input === undefined ? null : input;
    if (typeof input === "string") return text(input);
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "symbol" || typeof input === "function") return String(input);
    if (depth >= MAX_DEPTH) return "<max-depth>";
    if (input instanceof Error) return errorValue(input, depth, seen) as unknown as LogValue;
    if (input instanceof Date) return input.toISOString();
    if (input instanceof Uint8Array) return `<binary:${input.byteLength} bytes>`;
    if (typeof input !== "object") return text(String(input));
    if (seen.has(input)) return "<circular>";
    seen.add(input);
    if (Array.isArray(input)) {
      const out = input.slice(0, MAX_ARRAY).map((item) => value(item, undefined, depth + 1, seen));
      if (input.length > MAX_ARRAY) out.push(`<truncated:${input.length - MAX_ARRAY}>`);
      return out;
    }
    const entries = Object.entries(input).slice(0, MAX_KEYS);
    const out: Record<string, LogValue> = {};
    for (const [childKey, child] of entries) {
      out[childKey] = value(child, childKey, depth + 1, seen);
    }
    if (Object.keys(input).length > MAX_KEYS) out.__truncated__ = true;
    return out;
  }

  function errorValue(
    input: Error,
    depth = 0,
    seen = new WeakSet<object>(),
  ): LogError {
    const withCode = input as Error & { code?: unknown };
    const out: LogError = {
      name: text(input.name || "Error"),
      message: text(input.message),
      ...(input.stack ? { stack: text(input.stack) } : {}),
      ...(withCode.code !== undefined ? { code: text(String(withCode.code)) } : {}),
    };
    if (input.cause !== undefined && depth < MAX_DEPTH) {
      out.cause = value(input.cause, "cause", depth + 1, seen);
    }
    return out;
  }

  function error(input: unknown): LogError {
    if (input instanceof Error) return errorValue(input);
    const rendered = typeof input === "string" ? input : JSON.stringify(value(input));
    return { name: "Error", message: text(rendered ?? String(input)) };
  }

  return { value, text, error };
}

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && SENSITIVE_KEY.test(key))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 4);
}
