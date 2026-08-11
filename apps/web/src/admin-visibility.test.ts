import { describe, expect, it } from "vitest";
import { adminVisibility } from "./admin-visibility.js";

describe("admin visibility", () => {
  it("loads only the resource its own rail view needs", () => {
    expect(adminVisibility("inbox")).toEqual({
      skills: false,
      mcp: false,
      memories: false,
      triggers: false,
      plugins: false,
    });
    expect(adminVisibility("automations").triggers).toBe(true);
    expect(adminVisibility("skills").skills).toBe(true);
    expect(adminVisibility("mcp").mcp).toBe(true);
    expect(adminVisibility("memories").memories).toBe(true);
    expect(adminVisibility("plugins").plugins).toBe(true);
    expect(adminVisibility("settings")).toMatchObject({
      skills: false,
      mcp: false,
      memories: false,
      triggers: false,
    });
  });
});
