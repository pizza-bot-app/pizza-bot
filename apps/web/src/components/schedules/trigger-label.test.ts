import { describe, expect, it } from "vitest";
import { triggerLabel } from "./trigger-label.js";

describe("triggerLabel", () => {
  it("prefers the name and otherwise describes the trigger", () => {
    expect(triggerLabel({ kind: "cron", name: "Morning digest", cron: "0 9 * * *" })).toBe("Morning digest");
    expect(triggerLabel({ kind: "cron", cron: "0 9 * * *" })).not.toBe("");
    expect(triggerLabel({ kind: "webhook" })).toBe("Inbound webhook");
  });
});
