import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  hasBrowserSelection,
  installedBrowser,
  needsHeadlessMode,
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

test("uses an explicit browser path before automatic discovery", () => {
  const existing = new Set([
    "/configured/browser",
    "/usr/bin/google-chrome",
    "/cache/chrome-for-testing",
  ]);

  assert.deepEqual(
    installedBrowser({
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        PIZZA_PLAYWRIGHT_BROWSER_PATH: "/configured/browser",
      },
      exists: (candidate) => existing.has(candidate),
      managedExecutablePath: "/cache/chrome-for-testing",
    }),
    { executablePath: "/configured/browser" },
  );

  assert.equal(
    installedBrowser({
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        PIZZA_PLAYWRIGHT_BROWSER_PATH: "/configured/missing",
      },
      exists: (candidate) => existing.has(candidate),
      managedExecutablePath: "/cache/chrome-for-testing",
    }),
    undefined,
  );
});

test("checks conventional Linux locations outside the service PATH", () => {
  assert.deepEqual(
    installedBrowser({
      platform: "linux",
      env: { PATH: "/restricted/bin" },
      exists: (candidate) => candidate === "/opt/google/chrome/chrome",
    }),
    { executablePath: "/opt/google/chrome/chrome" },
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

test("uses headless mode on Linux without a display server", () => {
  assert.equal(
    needsHeadlessMode({ platform: "linux", env: { PATH: "/usr/bin" } }),
    true,
  );
  assert.equal(
    needsHeadlessMode({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: "/usr/bin" },
    }),
    false,
  );
  assert.equal(
    needsHeadlessMode({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" },
    }),
    false,
  );
  assert.equal(needsHeadlessMode({ platform: "darwin", env: {} }), false);
});

test("reports a missing configured browser through MCP initialization", { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./launch.mjs", import.meta.url))], {
    env: {
      ...process.env,
      PIZZA_PLAYWRIGHT_BROWSER_PATH: "/browser/does/not/exist",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const response = new Promise((resolve) => {
    lines.once("line", (line) => resolve(JSON.parse(line)));
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })}\n`,
  );

  const startupError = await response;
  assert.equal(startupError.jsonrpc, "2.0");
  assert.equal(startupError.id, 1);
  assert.equal(startupError.error.code, -32603);
  assert.match(startupError.error.message, /browser_not_found/);
  assert.match(startupError.error.message, /PIZZA_PLAYWRIGHT_BROWSER_PATH/);
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /browser_not_found/);
  assert.match(stderr, /PIZZA_PLAYWRIGHT_BROWSER_PATH/);
});
