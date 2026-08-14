import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasBrowserSelection,
  installedBrowser,
} from "./browser-selection.mjs";

const require = createRequire(import.meta.url);

if (!hasBrowserSelection(process.argv)) {
  const { chromium } = require("playwright");
  const browser = installedBrowser({
    managedExecutablePath: chromium.executablePath(),
  });
  if (!browser) {
    throw new Error(
      "Playwright Browser Automation could not find Chrome, Edge, Chromium, " +
        "or the required Chrome for Testing revision. Pizza Bot installers do " +
        "not include a browser. Install Chrome, Edge, or Chromium, then reconnect " +
        "the Playwright MCP server. When running from source, run " +
        "`npm run browser:install` first.",
    );
  }
  if (browser.channel) process.argv.push("--browser", browser.channel);
  if (browser.executablePath) process.argv.push("--executable-path", browser.executablePath);
}

const packageJson = require.resolve("@playwright/mcp/package.json");
await import(pathToFileURL(join(dirname(packageJson), "cli.js")).href);
