import { describe, expect, it } from "vitest";
import { initialThreadId } from "./initial-thread-selection.js";

describe("initialThreadId", () => {
  it("leaves an empty inbox without an active conversation", () => {
    expect(initialThreadId([])).toBeNull();
  });

  it("selects the most recently active persisted conversation", () => {
    expect(
      initialThreadId([
        {
          threadId: "older",
          lastActivityAt: "2026-08-10T12:00:00.000Z",
        },
        {
          threadId: "newer",
          lastActivityAt: "2026-08-12T12:00:00.000Z",
        },
      ]),
    ).toBe("newer");
  });
});
