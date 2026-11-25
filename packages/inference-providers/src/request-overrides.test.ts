import { describe, expect, it } from "vitest";
import { parseRequestOverrides } from "./request-overrides.js";

describe("parseRequestOverrides", () => {
  it("treats blank input as no overrides", () => {
    expect(parseRequestOverrides(undefined)).toBeUndefined();
    expect(parseRequestOverrides("  ")).toBeUndefined();
    expect(parseRequestOverrides("{}")).toBeUndefined();
  });

  it("returns the parsed object", () => {
    expect(parseRequestOverrides('{"service_tier":"flex","reasoning":{"effort":"low"}}')).toEqual({
      service_tier: "flex",
      reasoning: { effort: "low" },
    });
  });

  it.each(["{not json", "[1]", '"flex"', "null"])("rejects %s", (raw) => {
    expect(() => parseRequestOverrides(raw)).toThrow(/Advanced request JSON/);
  });

  it("rejects fields the agent depends on", () => {
    expect(() => parseRequestOverrides('{"model":"x","tools":[],"temperature":0}')).toThrow(
      'cannot set "model", "tools"',
    );
  });

  it("sends output caps to the token budget field", () => {
    expect(() => parseRequestOverrides('{"max_tokens":100}')).toThrow("output token budget");
  });
});
