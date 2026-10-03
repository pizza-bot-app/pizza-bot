import { describe, expect, it } from "vitest";
import { SmolvmSandboxPool } from "@pizza-bot/runtime-langgraph";
import { resolveSandboxPool } from "./sandbox.js";

function resolve(env: NodeJS.ProcessEnv, host = "linux-x64") {
  const warnings: string[] = [];
  const pool = resolveSandboxPool(env, host, (message) => warnings.push(message));
  return { pool, warnings };
}

describe("resolveSandboxPool", () => {
  it("stays off unless PIZZA_SANDBOX selects smolvm", () => {
    expect(resolve({}).pool).toBeUndefined();
    expect(resolve({ PIZZA_SANDBOX: "off" }).pool).toBeUndefined();
    const unknown = resolve({ PIZZA_SANDBOX: "docker" });
    expect(unknown.pool).toBeUndefined();
    expect(unknown.warnings[0]).toContain('unknown PIZZA_SANDBOX "docker"');
  });

  it("builds a pool on hosts smolvm supports", () => {
    for (const host of ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]) {
      expect(resolve({ PIZZA_SANDBOX: "smolvm" }, host).pool).toBeInstanceOf(SmolvmSandboxPool);
    }
  });

  it("stays off on Intel macOS, which smolvm does not build for", () => {
    const { pool, warnings } = resolve({ PIZZA_SANDBOX: "smolvm" }, "darwin-x64");
    expect(pool).toBeUndefined();
    expect(warnings[0]).toContain("no build for darwin-x64");
  });

  it("drops an image that could not be pulled without network", () => {
    const { pool, warnings } = resolve({
      PIZZA_SANDBOX: "smolvm",
      PIZZA_SANDBOX_IMAGE: "python:3.12-alpine",
    });
    expect(pool).toBeInstanceOf(SmolvmSandboxPool);
    expect(warnings[0]).toContain("PIZZA_SANDBOX_NETWORK=1");
  });
});
