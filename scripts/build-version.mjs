#!/usr/bin/env node
/**
 * Derives the version for an unpublished build of a branch: `0.0.<build>`, where
 * `<build>` is the commit count. Releases carry a committed version instead, so
 * reserving `0.x` here keeps the two apart.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Forge reads the app's version from this one for the bundle, the Squirrel/deb/rpm
// metadata, and `app.getVersion()`.
const STAMPED_MANIFEST = path.join("apps", "desktop-shell", "package.json");

export function resolveBuildNumber(cwd = repoRoot) {
  const count = execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (!/^\d+$/.test(count)) {
    throw new Error(`git rev-list returned a non-numeric count: ${count}`);
  }
  return Number(count);
}

export function composeVersion(build) {
  if (!Number.isInteger(build) || build < 0) {
    throw new Error(`build must be a non-negative integer: ${build}`);
  }
  return `0.0.${build}`;
}

/**
 * Rewrites the version through a JSON round-trip, the way `npm version` does, so
 * a `"version"` key nested in a dependency cannot be matched instead.
 */
export function stampVersion(manifestPath, version) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string") {
    throw new Error(`${manifestPath} has no version field to stamp`);
  }
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function main(argv) {
  // `--set` takes a version computed elsewhere so every packaging job stamps the
  // exact string the release filenames use, instead of each recomputing it.
  const explicit = readOption(argv, "--set");
  let version;
  if (explicit === undefined) {
    version = composeVersion(resolveBuildNumber());
  } else {
    if (!/^\d+\.\d+\.\d+$/.test(explicit)) {
      throw new Error(`--set requires three numeric fields: ${explicit}`);
    }
    version = explicit;
  }

  if (explicit !== undefined || argv.includes("--write")) {
    // `--manifest` keeps the tests off the tracked manifest; every caller in
    // .github/workflows relies on the default.
    const manifest = readOption(argv, "--manifest") ?? STAMPED_MANIFEST;
    stampVersion(path.resolve(repoRoot, manifest), version);
    console.error(`[build-version] stamped ${manifest} -> ${version}`);
  }

  process.stdout.write(`${version}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`build-version: ${error.message}`);
    process.exit(1);
  }
}
