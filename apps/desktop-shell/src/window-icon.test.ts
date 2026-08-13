import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowIconPath } from "./window-icon.js";

const appPath = path.join("/repo", "apps", "desktop-shell");
const resourcesPath = path.join("/installed", "resources");

describe("window icon", () => {
  it("uses the checked-in ICO for Windows development", () => {
    expect(
      resolveWindowIconPath({
        platform: "win32",
        packaged: false,
        appPath,
        resourcesPath,
      }),
    ).toBe(path.join("/repo", "assets", "icons", "icon.ico"));
  });

  it("uses the staged ICO for packaged Windows builds", () => {
    expect(
      resolveWindowIconPath({
        platform: "win32",
        packaged: true,
        appPath,
        resourcesPath,
      }),
    ).toBe(path.join(resourcesPath, "icon.ico"));
  });

  it("uses PNG on Linux and the app bundle icon on macOS", () => {
    expect(
      resolveWindowIconPath({
        platform: "linux",
        packaged: false,
        appPath,
        resourcesPath,
      }),
    ).toBe(path.join("/repo", "assets", "icons", "icon.png"));
    expect(
      resolveWindowIconPath({
        platform: "darwin",
        packaged: false,
        appPath,
        resourcesPath,
      }),
    ).toBeUndefined();
  });
});
