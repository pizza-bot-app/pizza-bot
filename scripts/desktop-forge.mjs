#!/usr/bin/env node
// Runs an electron-forge command in @pizza-bot/desktop-shell. On macOS it
// selects Homebrew's Node 24 and repairs Forge's native DMG helper when the
// dependency tree was installed by a Node version with a different ABI.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { resolveNpmCli } from "./npm-cli.mjs";

const forgeCommand = process.argv[2];
if (!forgeCommand) {
  console.error("usage: desktop-forge.mjs <package|make>");
  process.exit(1);
}

const brewNodeBin = "/opt/homebrew/opt/node@24/bin";
const env = { ...process.env };
const brewNode = `${brewNodeBin}/node`;
const nodeExecPath = process.platform === "darwin" && fs.existsSync(brewNode)
  ? brewNode
  : process.execPath;
if (nodeExecPath === brewNode) {
  env.PATH = `${brewNodeBin}:${env.PATH ?? ""}`;
}
const selectedVersion = spawnSync(nodeExecPath, ["--version"], {
  encoding: "utf8",
}).stdout?.trim();
if (!/^v24\./.test(selectedVersion ?? "")) {
  console.error(
    `desktop packaging requires Node 24 (selected ${selectedVersion || nodeExecPath})`,
  );
  process.exit(1);
}

if (process.platform === "darwin") {
  const nativeProbe = spawnSync(nodeExecPath, ["-e", "require('macos-alias')"], {
    env,
    stdio: "ignore",
  });
  if (nativeProbe.status !== 0) {
    console.log("[desktop-forge] rebuilding macos-alias for the selected Node runtime");
    const rebuild = spawnSync(nodeExecPath, [resolveNpmCli(), "rebuild", "macos-alias"], {
      env,
      stdio: "inherit",
    });
    if (rebuild.status !== 0) {
      process.exit(rebuild.status ?? 1);
    }
  }
}

const result = spawnSync(
  nodeExecPath,
  [resolveNpmCli(), "run", forgeCommand, "-w", "@pizza-bot/desktop-shell"],
  { stdio: "inherit", env },
);
process.exit(result.status ?? 1);
