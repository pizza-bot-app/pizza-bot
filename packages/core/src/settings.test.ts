import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  isFavoriteModels,
  isMaxToolCalls,
  MAX_FAVORITE_MODELS,
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

describe("isMaxToolCalls", () => {
  it("accepts positive integers and -1 for no limit", () => {
    expect(isMaxToolCalls(1)).toBe(true);
    expect(isMaxToolCalls(40)).toBe(true);
    expect(isMaxToolCalls(-1)).toBe(true);
  });

  it("rejects zero, other negatives, fractions, and non-numbers", () => {
    expect(isMaxToolCalls(0)).toBe(false);
    expect(isMaxToolCalls(-2)).toBe(false);
    expect(isMaxToolCalls(1.5)).toBe(false);
    expect(isMaxToolCalls("40")).toBe(false);
  });
});

describe("isFavoriteModels", () => {
  it("accepts unique non-empty model ids, including none", () => {
    expect(isFavoriteModels([])).toBe(true);
    expect(isFavoriteModels(["bedrock:sonnet", "openai:gpt-5"])).toBe(true);
  });

  it("rejects duplicates, empty ids, non-strings, oversized lists, and non-arrays", () => {
    expect(isFavoriteModels(["bedrock:sonnet", "bedrock:sonnet"])).toBe(false);
    expect(isFavoriteModels([""])).toBe(false);
    expect(isFavoriteModels([42])).toBe(false);
    expect(isFavoriteModels(Array.from({ length: MAX_FAVORITE_MODELS + 1 }, (_, i) => `p:${i}`))).toBe(false);
    expect(isFavoriteModels("bedrock:sonnet")).toBe(false);
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

  it("defaults the orchestrator and subagent tool-call limits", () => {
    expect(DEFAULT_SETTINGS.maxToolCalls).toBe(100);
    expect(DEFAULT_SETTINGS.maxSubagentToolCalls).toBe(150);
  });

  it("defaults to no favorite models", () => {
    expect(DEFAULT_SETTINGS.favoriteModels).toEqual([]);
  });
});
