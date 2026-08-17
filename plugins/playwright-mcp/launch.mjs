import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  hasBrowserSelection,
  installedBrowser,
  needsHeadlessMode,
} from "./browser-selection.mjs";

const require = createRequire(import.meta.url);

if (!hasBrowserSelection(process.argv)) {
  const { chromium } = require("playwright");
  const browser = installedBrowser({
    managedExecutablePath: chromium.executablePath(),
  });
  if (!browser) {
    const configuredPath = process.env.PIZZA_PLAYWRIGHT_BROWSER_PATH?.trim();
    const detail = configuredPath
      ? `PIZZA_PLAYWRIGHT_BROWSER_PATH does not point to an existing browser executable: ${configuredPath}`
      : "Chrome, Edge, Chromium, or the required Chrome for Testing revision was not found";
    const message =
      `browser_not_found: ${detail}. Install a browser on the backend host or ` +
      "set PIZZA_PLAYWRIGHT_BROWSER_PATH, then reconnect the Playwright MCP server. " +
      "A host browser is not visible inside a container. When running from source, " +
      "run `npm run browser:install` first.";
    process.stderr.write(`[playwright-mcp] ${message}\n`);
    await reportStartupError(message);
  } else {
    if (browser.channel) process.argv.push("--browser", browser.channel);
    if (browser.executablePath) process.argv.push("--executable-path", browser.executablePath);
    if (needsHeadlessMode()) process.argv.push("--headless");

    const packageJson = require.resolve("@playwright/mcp/package.json");
    await import(pathToFileURL(join(dirname(packageJson), "cli.js")).href);
  }
} else {
  const packageJson = require.resolve("@playwright/mcp/package.json");
  await import(pathToFileURL(join(dirname(packageJson), "cli.js")).href);
}

async function reportStartupError(message) {
  const lines = createInterface({ input: process.stdin });
  await new Promise((resolve) => {
    lines.on("line", (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      if (request.method !== "initialize" || request.id === undefined) return;
      const response = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message },
      };
      process.stdout.write(`${JSON.stringify(response)}\n`, () => {
        lines.close();
        process.stdin.unref?.();
        resolve();
      });
    });
    lines.on("close", resolve);
  });
  process.exitCode = 1;
}
