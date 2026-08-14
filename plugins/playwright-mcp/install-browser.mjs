import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const executablePath = chromium.executablePath();

if (existsSync(executablePath)) {
  console.log(`[browser:install] Chrome for Testing is ready: ${executablePath}`);
} else {
  const packageJson = require.resolve("playwright/package.json");
  const cli = join(dirname(packageJson), "cli.js");
  const child = spawn(process.execPath, [cli, "install", "chromium"], {
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`Playwright browser installation exited with code ${code}`);
  }
}
