import { describe, it, expect } from "vitest";
import {
  DEFAULT_TITLE,
  isDefaultTitle,
  cleanTitle,
  buildTitleUserMessage,
} from "./title.js";

describe("isDefaultTitle", () => {
  it("treats the default title as replaceable", () => {
    expect(isDefaultTitle(DEFAULT_TITLE)).toBe(true);
    expect(isDefaultTitle("New conversation")).toBe(true);
  });

  it("treats empty / whitespace / null / undefined as replaceable", () => {
    expect(isDefaultTitle("")).toBe(true);
    expect(isDefaultTitle("   ")).toBe(true);
    expect(isDefaultTitle(null)).toBe(true);
    expect(isDefaultTitle(undefined)).toBe(true);
  });

  it("never replaces a user-set / generated title", () => {
    expect(isDefaultTitle("Weekly sales report")).toBe(false);
    expect(isDefaultTitle("New conversation ideas")).toBe(false);
    expect(isDefaultTitle("Chat about pizza")).toBe(false);
  });
});

describe("cleanTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanTitle("  Weekly   sales report \n")).toBe("Weekly sales report");
  });

  it("strips surrounding quotes (straight and curly)", () => {
    expect(cleanTitle('"Python regex help"')).toBe("Python regex help");
    expect(cleanTitle("'Logo design feedback'")).toBe("Logo design feedback");
    expect(cleanTitle("“Vacation budget planning”")).toBe("Vacation budget planning");
  });

  it("drops a leading 'Title:' label the model sometimes emits", () => {
    expect(cleanTitle("Title: Weekly sales report")).toBe("Weekly sales report");
    expect(cleanTitle("title:  pizza toppings")).toBe("pizza toppings");
  });

  it("strips trailing sentence punctuation", () => {
    expect(cleanTitle("Weekly sales report.")).toBe("Weekly sales report");
    expect(cleanTitle("Is this a question?")).toBe("Is this a question");
  });

  it("returns undefined for empty / whitespace-only / nullish output", () => {
    expect(cleanTitle("")).toBeUndefined();
    expect(cleanTitle("   ")).toBeUndefined();
    expect(cleanTitle(null)).toBeUndefined();
    expect(cleanTitle(undefined)).toBeUndefined();
    expect(cleanTitle('""')).toBeUndefined();
  });

  it("caps an over-long title with an ellipsis", () => {
    const long = "a".repeat(100);
    const out = cleanTitle(long)!;
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildTitleUserMessage", () => {
  it("labels both turns and caps each at 500 chars", () => {
    const out = buildTitleUserMessage("a".repeat(600), "b".repeat(600));
    expect(out).toContain("User message: ");
    expect(out).toContain("Assistant response: ");
    expect(out).toContain("a".repeat(500));
    expect(out).not.toContain("a".repeat(501));
    expect(out).toContain("b".repeat(500));
  });
});
