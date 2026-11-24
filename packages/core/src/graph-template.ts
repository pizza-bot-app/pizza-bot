/** `{{path}}` templates and branch conditions over graph state; no expressions, so runs stay deterministic. */
import type { GraphCondition } from "./graph-spec.js";

// Capture without surrounding \s*, which would overlap the path and backtrack
// polynomially on long runs of spaces; paths are trimmed instead.
const TEMPLATE = /\{\{([^{}]*)\}\}/g;
const WHOLE_TEMPLATE = /^\{\{([^{}]*)\}\}$/;

export function readPath(state: unknown, path: string): unknown {
  let current: unknown = state;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A string that is exactly one `{{path}}` yields the raw value; otherwise values interpolate as text. */
export function renderTemplate(template: string, state: unknown): unknown {
  const whole = WHOLE_TEMPLATE.exec(template);
  if (whole && whole[1]!.trim()) return readPath(state, whole[1]!.trim());
  return template.replace(TEMPLATE, (match, path: string) =>
    path.trim() ? stringify(readPath(state, path.trim())) : match,
  );
}

export function renderText(template: string, state: unknown): string {
  return stringify(renderTemplate(template, state));
}

/** Render every string inside a JSON value. */
export function renderValue(value: unknown, state: unknown): unknown {
  if (typeof value === "string") return renderTemplate(value, state);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, state));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderValue(v, state)]),
    );
  }
  return value;
}

export function evaluateCondition(condition: GraphCondition, state: unknown): boolean {
  const actual = readPath(state, condition.path);
  const expected = condition.value;
  switch (condition.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "truthy":
      return Boolean(actual);
    case "eq":
      return deepEqual(actual, expected);
    case "neq":
      return !deepEqual(actual, expected);
    case "contains":
      if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
      if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected));
      return false;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compare(actual, expected, condition.op);
  }
}

function compare(actual: unknown, expected: unknown, op: "gt" | "gte" | "lt" | "lte"): boolean {
  const comparable =
    (typeof actual === "number" && typeof expected === "number") ||
    (typeof actual === "string" && typeof expected === "string");
  if (!comparable) return false;
  const a = actual as number | string;
  const b = expected as number | string;
  if (op === "gt") return a > b;
  if (op === "gte") return a >= b;
  if (op === "lt") return a < b;
  return a <= b;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
