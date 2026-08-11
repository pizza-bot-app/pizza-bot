import { describe, expect, it } from "vitest";
import { provenanceBadgeLabel } from "./ProvenanceBadge.js";

describe("provenanceBadgeLabel", () => {
  it("labels shipped skill overrides as customized", () => {
    expect(provenanceBadgeLabel("user", "builtin")).toBe("Customized");
    expect(provenanceBadgeLabel("user", "plugin")).toBe("Customized");
  });

  it("keeps standalone user skills custom", () => {
    expect(provenanceBadgeLabel("user")).toBe("Custom");
  });
});
