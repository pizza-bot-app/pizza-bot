import { describe, it, expect, afterEach } from "vitest";
import {
  resolveMaxTokens,
  resolveRegion,
  supportedToolChoiceValues,
  supportsReasoning,
} from "./models.js";

describe("resolveMaxTokens", () => {
  const orig = process.env.PIZZA_MAX_TOKENS;
  afterEach(() => {
    if (orig === undefined) delete process.env.PIZZA_MAX_TOKENS;
    else process.env.PIZZA_MAX_TOKENS = orig;
  });

  it("prefers an explicit positive value", () => {
    expect(resolveMaxTokens(4096)).toBe(4096);
  });

  it("ignores a non-positive explicit value and falls through", () => {
    delete process.env.PIZZA_MAX_TOKENS;
    expect(resolveMaxTokens(0)).toBe(8192);
    expect(resolveMaxTokens(-1)).toBe(8192);
  });

  it("honors PIZZA_MAX_TOKENS when no explicit value", () => {
    process.env.PIZZA_MAX_TOKENS = "16000";
    expect(resolveMaxTokens()).toBe(16000);
  });

  it("defaults to 8192 (not @langchain/aws's dangerous 4096) so Sonnet 5 thinking can't blank the turn", () => {
    delete process.env.PIZZA_MAX_TOKENS;
    expect(resolveMaxTokens()).toBe(8192);
  });

  it("ignores a non-numeric PIZZA_MAX_TOKENS", () => {
    process.env.PIZZA_MAX_TOKENS = "lots";
    expect(resolveMaxTokens()).toBe(8192);
  });
});

describe("resolveRegion", () => {
  it("prefers the explicit region", () => {
    expect(resolveRegion("eu-west-1")).toBe("eu-west-1");
  });
});

describe("supportedToolChoiceValues", () => {
  it("asserts the full set for claude-sonnet-5 (which @langchain/aws's stale matcher rejects client-side)", () => {
    expect(supportedToolChoiceValues("global.anthropic.claude-sonnet-5")).toEqual([
      "auto",
      "any",
      "tool",
    ]);
  });

  it("covers every Claude family (haiku/opus ids too)", () => {
    expect(supportedToolChoiceValues("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual([
      "auto",
      "any",
      "tool",
    ]);
    expect(supportedToolChoiceValues("global.anthropic.claude-opus-5")).toEqual([
      "auto",
      "any",
      "tool",
    ]);
  });

  it("defers to @langchain/aws (undefined) for a non-Claude model so its own guard applies", () => {
    expect(supportedToolChoiceValues("mistral.mistral-large-2407-v1:0")).toBeUndefined();
  });
});

describe("supportsReasoning", () => {
  it("is true for the adaptive-thinking models (verified live: Sonnet 5, Opus)", () => {
    expect(supportsReasoning("global.anthropic.claude-sonnet-5")).toBe(true);
    expect(supportsReasoning("global.anthropic.claude-opus-5")).toBe(true);
  });

  it("is false for Haiku (rejects adaptive thinking) and non-Claude models", () => {
    expect(supportsReasoning("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(false);
    expect(supportsReasoning("mistral.mistral-large-2407-v1:0")).toBe(false);
  });
});
