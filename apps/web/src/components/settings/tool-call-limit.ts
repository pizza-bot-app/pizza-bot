/** Blur-time decision for a tool-call limit field, where an empty draft means "no limit". */

export const NO_TOOL_CALL_LIMIT = -1;

export type ToolCallLimitEdit =
  | { kind: "save"; value: number }
  | { kind: "unchanged" }
  | { kind: "invalid" };

/** Canonical field text for a stored limit; "no limit" shows as an empty field. */
export function toolCallLimitDraft(value: number): string {
  return value > 0 ? String(value) : "";
}

export function resolveToolCallLimitEdit(draft: string, current: number): ToolCallLimitEdit {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return current === NO_TOOL_CALL_LIMIT ? { kind: "unchanged" } : { kind: "save", value: NO_TOOL_CALL_LIMIT };
  }
  // Digits only: `Number` would otherwise accept "1e3", "0x10", and " 12 " as limits.
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return { kind: "invalid" };
  return value === current ? { kind: "unchanged" } : { kind: "save", value };
}
