import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeVersion, resolveBuildNumber, stampVersion } from "./build-version.mjs";

const scriptPath = fileURLToPath(new URL("./build-version.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

function withTempDir(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "build-version-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Returns the manifest path, so no test ever writes to a tracked file. */
function writeManifest(directory, manifest) {
  const manifestPath = path.join(directory, "package.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function runScript(args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runScriptExpectingFailure(args) {
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { status: error.status, stderr: error.stderr };
  }
  throw new Error(`expected a failure from: ${args.join(" ")}`);
}

test("composes a semver-valid initial-development version", () => {
  assert.equal(composeVersion(0), "0.0.0");
  assert.equal(composeVersion(68), "0.0.68");
});

test("rejects a build that is not a non-negative integer", () => {
  for (const bad of [-1, 1.5, "68", undefined, NaN]) {
    assert.throws(() => composeVersion(bad), /non-negative integer/, String(bad));
  }
});

test("stamps the version and leaves every other field untouched", () => {
  withTempDir((directory) => {
    const manifestPath = writeManifest(directory, {
      name: "@pizza-bot/desktop-shell",
      version: "1.0.0",
      private: true,
      dependencies: { tsx: "^4.23.11" },
    });

    stampVersion(manifestPath, "0.0.68");

    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), {
      name: "@pizza-bot/desktop-shell",
      version: "0.0.68",
      private: true,
      dependencies: { tsx: "^4.23.11" },
    });
  });
});

// A regex over the raw text matches the first `"version"` it finds, which for a
// dependency of that name is the wrong field.
test("stamps the top-level version, not a dependency named version", () => {
  withTempDir((directory) => {
    const manifestPath = writeManifest(directory, {
      dependencies: { version: "^7.0.0" },
      version: "1.0.0",
    });

    stampVersion(manifestPath, "0.0.9");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.version, "0.0.9");
    assert.equal(manifest.dependencies.version, "^7.0.0");
  });
});

test("stamping the same version twice is not an error", () => {
  withTempDir((directory) => {
    const manifestPath = writeManifest(directory, { version: "1.0.0" });
    stampVersion(manifestPath, "0.0.5");
    stampVersion(manifestPath, "0.0.5");
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, "0.0.5");
  });
});

test("refuses to stamp a manifest with no version field", () => {
  withTempDir((directory) => {
    const manifestPath = writeManifest(directory, { name: "no-version" });
    assert.throws(() => stampVersion(manifestPath, "0.0.1"), /no version field/);
  });
});

// Reading the clock or a CI counter would give a rebuild of one commit a
// different version than the build that shipped from it.
test("derives the version from the commit count, stably", () => {
  const expected = `0.0.${resolveBuildNumber(repoRoot)}`;
  assert.equal(runScript([]), expected);
  assert.equal(runScript([]), expected);
});

test("--set stamps the version it is given", () => {
  withTempDir((directory) => {
    const manifestPath = writeManifest(directory, { version: "1.0.0" });

    assert.equal(runScript(["--set", "0.0.123", "--manifest", manifestPath]), "0.0.123");

    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, "0.0.123");
  });
});

test("--write stamps the derived version", () => {
  withTempDir((directory) => {
    const manifestPath = writeManifest(directory, { version: "1.0.0" });

    const printed = runScript(["--write", "--manifest", manifestPath]);

    assert.equal(printed, `0.0.${resolveBuildNumber(repoRoot)}`);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, printed);
  });
});

test("--set rejects a version that is not three numeric fields", () => {
  for (const bad of ["b123", "0.0", "1.0.0-b123", "2026.9"]) {
    const { status, stderr } = runScriptExpectingFailure(["--set", bad]);
    assert.equal(status, 1, bad);
    assert.match(stderr, /three numeric fields/, bad);
  }
});

// The likeliest typo, and it used to fall through to the derived version and
// silently stamp nothing.
test("a flag given without a value fails instead of being ignored", () => {
  for (const args of [["--set"], ["--write", "--manifest"], ["--set", "--write"]]) {
    const { status, stderr } = runScriptExpectingFailure(args);
    assert.equal(status, 1, args.join(" "));
    assert.match(stderr, /requires a value/, args.join(" "));
  }
});
