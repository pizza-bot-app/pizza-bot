import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleasableVersion,
  comesAfter,
  newestReleasedVersion,
} from "./prepare-release.mjs";

test("accepts a numeric release version", () => {
  for (const version of ["1.0.0", "1.1.0", "2.10.3"]) {
    assertReleasableVersion(version);
  }
});

test("rejects versions the makers cannot carry", () => {
  for (const bad of ["1.0", "v1.0.0", "1.0.0-rc1", "1.0.0.1", "latest", ""]) {
    assert.throws(() => assertReleasableVersion(bad), /major\.minor\.patch/, bad);
  }
});

test("reserves 0.x for on-demand builds", () => {
  assert.throws(() => assertReleasableVersion("0.0.70"), /reserved/);
  assert.throws(() => assertReleasableVersion("0.1.0"), /reserved/);
});

// Field-wise comparison, because a lexical one orders 1.10.0 below 1.9.0.
test("orders versions numerically, not lexically", () => {
  assert.equal(comesAfter("1.10.0", "1.9.0"), true);
  assert.equal(comesAfter("1.9.0", "1.10.0"), false);
  assert.equal(comesAfter("1.0.10", "1.0.9"), true);
  assert.equal(comesAfter("2.0.0", "1.99.99"), true);
  assert.equal(comesAfter("1.0.0", "1.0.0"), false);
});

test("finds the newest release tag and ignores anything else", () => {
  assert.equal(
    newestReleasedVersion(["v1.0.0", "v1.10.0", "v1.9.0", "v2.0.0"]),
    "2.0.0",
  );
  assert.equal(newestReleasedVersion(["v1.0.0", "b70", "v1.2.0-rc1", "nightly"]), "1.0.0");
  assert.equal(newestReleasedVersion([]), undefined);
  assert.equal(newestReleasedVersion(["b70", "nightly"]), undefined);
});
