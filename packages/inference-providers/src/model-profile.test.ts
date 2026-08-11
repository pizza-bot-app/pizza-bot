import { describe, expect, it } from "vitest";
import { withContextWindow } from "./model-profile.js";

describe("withContextWindow", () => {
  it("overrides only the input limit", () => {
    expect(withContextWindow({
      maxInputTokens: 128_000,
      maxOutputTokens: 16_000,
      imageInputs: true,
      toolCalling: true,
    }, 200_000)).toEqual({
      maxInputTokens: 200_000,
      maxOutputTokens: 16_000,
      imageInputs: true,
      toolCalling: true,
    });
  });

  it("preserves the native profile when no valid limit is available", () => {
    const profile = { maxInputTokens: 128_000, toolCalling: true };
    expect(withContextWindow(profile, undefined)).toBe(profile);
    expect(withContextWindow(profile, 0)).toBe(profile);
  });
});
