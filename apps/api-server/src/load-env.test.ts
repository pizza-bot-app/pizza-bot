import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadDotEnv, resolveDataRoot } from "./load-env.js";

const VARS = ["PIZZA_LOAD_ENV_TEST", "PIZZA_LOAD_ENV_TEST_PRESET"];

describe("loadDotEnv", () => {
  let dataRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "load-env-"));
    prevDataRoot = process.env.PIZZA_DATA_ROOT;
    process.env.PIZZA_DATA_ROOT = dataRoot;
    for (const v of VARS) delete process.env[v];
  });

  afterEach(() => {
    if (prevDataRoot === undefined) delete process.env.PIZZA_DATA_ROOT;
    else process.env.PIZZA_DATA_ROOT = prevDataRoot;
    for (const v of VARS) delete process.env[v];
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("backfills unset vars from a .env in the data root", () => {
    writeFileSync(join(dataRoot, ".env"), "PIZZA_LOAD_ENV_TEST=from_data_root\n");
    loadDotEnv();
    expect(process.env.PIZZA_LOAD_ENV_TEST).toBe("from_data_root");
  });

  it("prefers .env.local over .env in the same directory", () => {
    writeFileSync(join(dataRoot, ".env"), "PIZZA_LOAD_ENV_TEST=from_env\n");
    writeFileSync(join(dataRoot, ".env.local"), "PIZZA_LOAD_ENV_TEST=from_env_local\n");
    loadDotEnv();
    expect(process.env.PIZZA_LOAD_ENV_TEST).toBe("from_env_local");
  });

  it("never overrides an already-set variable", () => {
    process.env.PIZZA_LOAD_ENV_TEST_PRESET = "from_shell";
    writeFileSync(join(dataRoot, ".env"), "PIZZA_LOAD_ENV_TEST_PRESET=from_file\n");
    writeFileSync(join(dataRoot, ".env.local"), "PIZZA_LOAD_ENV_TEST_PRESET=from_local_file\n");
    loadDotEnv();
    expect(process.env.PIZZA_LOAD_ENV_TEST_PRESET).toBe("from_shell");
  });

  it("is a no-op when no candidate directory has an env file", () => {
    expect(() => loadDotEnv()).not.toThrow();
    expect(process.env.PIZZA_LOAD_ENV_TEST).toBeUndefined();
  });

  it("uses an absolute home-directory fallback when HOME is unset", () => {
    const previousHome = process.env.HOME;
    delete process.env.PIZZA_DATA_ROOT;
    delete process.env.HOME;
    try {
      const root = resolveDataRoot();
      expect(isAbsolute(root)).toBe(true);
      expect(root).not.toContain("undefined");
    } finally {
      process.env.PIZZA_DATA_ROOT = dataRoot;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
