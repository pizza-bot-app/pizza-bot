import { describe, expect, it } from "vitest";
import { slugify } from "./utils.js";

describe("slugify", () => {
  it("normalizes words and trims separator runs from both ends", () => {
    expect(slugify("  Release Notes: Weekly!  ", "untitled")).toBe(
      "release-notes-weekly",
    );
  });

  it("uses the fallback when no alphanumeric characters remain", () => {
    expect(slugify("---", "untitled")).toBe("untitled");
  });
});
