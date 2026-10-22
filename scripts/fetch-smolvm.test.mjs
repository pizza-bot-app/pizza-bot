import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SMOLVM_RELEASES, SMOLVM_VERSION, fetchSmolvm, releaseFor } from "./fetch-smolvm.mjs";

test("pins a release for every desktop target smolvm builds", () => {
  assert.deepEqual(Object.keys(SMOLVM_RELEASES).sort(), [
    "darwin-arm64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ]);
  for (const release of Object.values(SMOLVM_RELEASES)) {
    assert.ok(release.asset.startsWith(`smolvm-${SMOLVM_VERSION}-`));
    assert.match(release.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(releaseFor("win32", "x64").asset, `smolvm-${SMOLVM_VERSION}-windows-x86_64.zip`);
});

test("clears a stale stage for a target without a smolvm build", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "fetch-smolvm-"));
  try {
    const output = path.join(directory, "smolvm");
    mkdirSync(output);
    writeFileSync(path.join(output, "smolvm-bin"), "");

    assert.equal(await fetchSmolvm({ platform: "darwin", arch: "x64", output }), false);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("ships notices for the pinned release and its GPL and LGPL components", () => {
  const notices = readFileSync(
    fileURLToPath(new URL("../apps/desktop-shell/smolvm-notices.txt", import.meta.url)),
    "utf8",
  );
  assert.ok(notices.includes(`smolvm ${SMOLVM_VERSION}`));
  for (const required of ["libkrun", "libkrunfw", "BusyBox", "GNU GENERAL PUBLIC LICENSE", "GNU LESSER GENERAL PUBLIC LICENSE"]) {
    assert.ok(notices.includes(required), `missing ${required}`);
  }
});
