import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  MAX_PROMPT_ADDENDUM_LENGTH,
  isPromptAddendum,
  isThemePreference,
} from "./settings.js";

describe("isThemePreference", () => {
  it("accepts the three known preferences", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isThemePreference("neon")).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

describe("isPromptAddendum", () => {
  it("accepts a string within the length bound, including empty", () => {
    expect(isPromptAddendum("")).toBe(true);
    expect(isPromptAddendum("Be concise.")).toBe(true);
    expect(isPromptAddendum("x".repeat(MAX_PROMPT_ADDENDUM_LENGTH))).toBe(true);
  });

  it("rejects an over-long string and non-strings", () => {
    expect(isPromptAddendum("x".repeat(MAX_PROMPT_ADDENDUM_LENGTH + 1))).toBe(false);
    expect(isPromptAddendum(42)).toBe(false);
    expect(isPromptAddendum(undefined)).toBe(false);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("defaults the persona addendum to an empty string", () => {
    expect(DEFAULT_SETTINGS.customPromptAddendum).toBe("");
  });

  it("defaults the feature flags off", () => {
    expect(DEFAULT_SETTINGS.enableMemories).toBe(false);
    expect(DEFAULT_SETTINGS.enableAutomations).toBe(false);
  });
});
