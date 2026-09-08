#!/usr/bin/env node
/**
 * Bumps every workspace and both lockfiles for a release, which `release.yml`
 * rejects the tag over if any of them disagree.
 *
 * A local script rather than a workflow: GitHub suppresses workflow runs for
 * events a `GITHUB_TOKEN` creates, so a bot-opened pull request could never
 * satisfy the required checks that protect `main`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmCli } from "./npm-cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function readCurrentVersion(root = repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}

export function assertReleasableVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be major.minor.patch, got ${version}`);
  }
  // rpm forbids `-` in a version and CFBundleVersion is numeric-only, so a
  // prerelease label would fail late, inside a packaging job.
  if (version.startsWith("0.")) {
    throw new Error("0.x is reserved for on-demand builds");
  }
}

/** Compares two numeric triples without shelling out to `sort -V`. */
export function comesAfter(version, existing) {
  const a = version.split(".").map(Number);
  const b = existing.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function newestReleasedVersion(tags) {
  return tags
    .map((tag) => /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1])
    .filter((version) => version !== undefined)
    .reduce((newest, version) => {
      return newest === undefined || comesAfter(version, newest) ? version : newest;
    }, undefined);
}

function main(argv) {
  const version = argv[0];
  if (!version) {
    throw new Error("usage: prepare-release.mjs <version>   (for example 1.1.0)");
  }
  assertReleasableVersion(version);

  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("the working tree has uncommitted changes; commit or stash first");
  }

  const current = readCurrentVersion();
  if (current === version) {
    throw new Error(
      `already at ${version} — if the tag was never pushed, push it instead of bumping again`,
    );
  }

  const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
  if (tags.includes(`v${version}`)) {
    throw new Error(`tag v${version} already exists`);
  }
  const newest = newestReleasedVersion(tags);
  if (newest !== undefined && !comesAfter(version, newest)) {
    throw new Error(`${version} does not come after the newest release ${newest}`);
  }

  // Spawned through node so Windows needs no shell; see npm-cli.mjs.
  const npm = resolveNpmCli();
  for (const args of [
    ["version", version, "--workspaces", "--include-workspace-root", "--no-git-tag-version"],
    ["install", "--package-lock-only"],
    ["install", "--package-lock-only", "--ignore-scripts", "--prefix", "plugins"],
  ]) {
    execFileSync(process.execPath, [npm, ...args], { cwd: repoRoot, stdio: "inherit" });
  }

  console.log(
    [
      "",
      `Bumped ${current} -> ${version}. Open it as a pull request so CI runs:`,
      "",
      `  git switch -c release/v${version}`,
      `  git commit -am "chore: release v${version}"`,
      `  git push -u origin release/v${version}`,
      "",
      "Then, once it is merged, tag the merge commit to start the release:",
      "",
      "  git switch main && git pull",
      `  git tag -s v${version} && git push origin v${version}`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`prepare-release: ${error.message}`);
    process.exit(1);
  }
}
