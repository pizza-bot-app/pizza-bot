import { describe, expect, it } from "vitest";
import { isAllowedRendererNavigation } from "./navigation-policy.js";

describe("renderer navigation policy", () => {
  it("allows reloads and in-document state on the renderer entry", () => {
    expect(
      isAllowedRendererNavigation(
        "file:///Applications/Pizza/resources/dist/index.html?view=inbox#thread",
        "file:///Applications/Pizza/resources/dist/index.html",
      ),
    ).toBe(true);
  });

  it("rejects arbitrary web and local-file navigation", () => {
    const entry = "file:///Applications/Pizza/resources/dist/index.html";
    expect(isAllowedRendererNavigation("https://evil.example/", entry)).toBe(false);
    expect(isAllowedRendererNavigation("file:///tmp/evil.html", entry)).toBe(false);
  });
});
