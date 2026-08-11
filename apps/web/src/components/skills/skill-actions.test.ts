import { describe, expect, it } from "vitest";
import { skillRemovalPresentation } from "./skill-actions.js";

describe("skillRemovalPresentation", () => {
  it("presents a built-in override as a reversible customization", () => {
    expect(skillRemovalPresentation({ overrides: "builtin" })).toEqual({
      title: "Revert skill?",
      label: "Revert to built-in",
      confirmLabel: "Revert",
      confirmation:
        "Revert this skill to the built-in version? Your customizations will be removed.",
      mode: "revert",
    });
  });

  it("presents a plugin override as a reversible customization", () => {
    expect(skillRemovalPresentation({ overrides: "plugin" }).label).toBe(
      "Revert to plugin",
    );
  });

  it("keeps standalone custom skill deletion destructive", () => {
    expect(skillRemovalPresentation({})).toEqual({
      title: "Delete skill?",
      label: "Delete",
      confirmLabel: "Delete",
      confirmation: "Delete this skill? This can’t be undone.",
      mode: "delete",
    });
  });
});
