import { describe, expect, it } from "vitest";
import { approvalEditState } from "./approval-edit.js";

describe("approval edit controls", () => {
  it("keeps the original approval action for an unchanged draft", () => {
    expect(approvalEditState('{"subject":"Hello"}', '{"subject":"Hello"}')).toEqual({
      changed: false,
      approveLabel: "Approve",
    });
  });

  it("distinguishes approval of edited arguments", () => {
    expect(approvalEditState('{"subject":"Hello"}', '{"subject":"Hi"}')).toEqual({
      changed: true,
      approveLabel: "Approve edited",
    });
  });
});
