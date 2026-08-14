import assert from "node:assert/strict";
import test from "node:test";
import {
  hasBrowserSelection,
  installedBrowser,
} from "./browser-selection.mjs";

test("recognizes explicit browser selection flags", () => {
  assert.equal(hasBrowserSelection(["node", "launch.mjs", "--browser=firefox"]), true);
  assert.equal(hasBrowserSelection(["node", "launch.mjs", "--executable-path", "/browser"]), true);
  assert.equal(hasBrowserSelection(["node", "launch.mjs"]), false);
});

test("prefers a supported system browser over the managed cache", () => {
  const existing = new Set([
    "/Applications/Google Chrome.app",
    "/cache/chrome-for-testing",
  ]);

  assert.deepEqual(
    installedBrowser({
      platform: "darwin",
      exists: (candidate) => existing.has(candidate),
      managedExecutablePath: "/cache/chrome-for-testing",
    }),
    { channel: "chrome" },
  );
});

test("uses the managed browser only when its executable exists", () => {
  assert.deepEqual(
    installedBrowser({
      platform: "darwin",
      exists: (candidate) => candidate === "/cache/chrome-for-testing",
      managedExecutablePath: "/cache/chrome-for-testing",
    }),
    { executablePath: "/cache/chrome-for-testing" },
  );

  assert.equal(
    installedBrowser({
      platform: "darwin",
      exists: () => false,
      managedExecutablePath: "/cache/missing",
    }),
    undefined,
  );
});
