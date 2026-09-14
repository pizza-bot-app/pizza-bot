import { describe, expect, it } from "vitest";
import { NO_TOOL_CALL_LIMIT, resolveToolCallLimitEdit, toolCallLimitDraft } from "./tool-call-limit.js";

describe("toolCallLimitDraft", () => {
  it("shows a positive limit and leaves 'no limit' empty", () => {
    expect(toolCallLimitDraft(40)).toBe("40");
    expect(toolCallLimitDraft(NO_TOOL_CALL_LIMIT)).toBe("");
  });
});

describe("resolveToolCallLimitEdit", () => {
  it("reads a cleared field as no limit", () => {
    expect(resolveToolCallLimitEdit("", 40)).toEqual({ kind: "save", value: NO_TOOL_CALL_LIMIT });
    expect(resolveToolCallLimitEdit("   ", 40)).toEqual({ kind: "save", value: NO_TOOL_CALL_LIMIT });
  });

  it("saves a positive whole number", () => {
    expect(resolveToolCallLimitEdit("120", 40)).toEqual({ kind: "save", value: 120 });
    expect(resolveToolCallLimitEdit(" 120 ", 40)).toEqual({ kind: "save", value: 120 });
  });

  // Turning the safety limit off has to be a deliberate clear, never a typo.
  it.each(["1e", "-", ".", "+", "1e3", "0x10", "12.5", "-5", "0", "abc"])(
    "rejects %j instead of falling through to no limit",
    (draft) => {
      expect(resolveToolCallLimitEdit(draft, 40)).toEqual({ kind: "invalid" });
    },
  );

  it("rejects an integer past the safe range", () => {
    expect(resolveToolCallLimitEdit("9007199254740993", 40)).toEqual({ kind: "invalid" });
  });

  it("skips a write when the draft matches what is stored", () => {
    expect(resolveToolCallLimitEdit("40", 40)).toEqual({ kind: "unchanged" });
    expect(resolveToolCallLimitEdit(" 40 ", 40)).toEqual({ kind: "unchanged" });
    expect(resolveToolCallLimitEdit("", NO_TOOL_CALL_LIMIT)).toEqual({ kind: "unchanged" });
  });
});
