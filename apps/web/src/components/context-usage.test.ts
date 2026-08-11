import { describe, expect, it } from "vitest";
import { contextUsageDisplay } from "./context-usage.js";

describe("contextUsageDisplay", () => {
  it("omits the count until a model response reports usage", () => {
    expect(contextUsageDisplay(undefined, 200_000)).toBeUndefined();
  });

  it("shows known usage when the model context window is unavailable", () => {
    expect(contextUsageDisplay({ input: 1_200, output: 300 }, undefined)).toEqual({
      used: 1_500,
    });
  });

  it("includes a valid context window for percentage display", () => {
    expect(contextUsageDisplay({ input: 1_200, output: 300 }, 200_000)).toEqual({
      used: 1_500,
      windowSize: 200_000,
    });
  });

  it("ignores invalid context-window values without hiding usage", () => {
    expect(contextUsageDisplay({ input: 1_200, output: 300 }, 0)).toEqual({
      used: 1_500,
    });
  });
});
