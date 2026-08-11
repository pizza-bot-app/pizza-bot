import { describe, it, expect } from "vitest";
import { isForkableTurn, type UIMessageLike } from "./adapter.js";

describe("isForkableTurn", () => {
  const message = (
    role: UIMessageLike["role"],
    parts: UIMessageLike["parts"],
  ): UIMessageLike => ({ id: "h_0", role, parts });

  it("allows completed assistant turns", () => {
    expect(isForkableTurn(message("assistant", [{ type: "text", text: "done" }]))).toBe(true);
    expect(
      isForkableTurn(
        message("assistant", [
          { type: "tool-search", toolCallId: "t1", state: "output-available" },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects non-assistant and unfinished tool turns", () => {
    expect(isForkableTurn(message("user", [{ type: "text", text: "hi" }]))).toBe(false);
    expect(
      isForkableTurn(
        message("assistant", [
          { type: "tool-search", toolCallId: "t1", state: "approval-requested" },
        ]),
      ),
    ).toBe(false);
  });
});
