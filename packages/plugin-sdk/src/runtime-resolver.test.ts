import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  findMcpNode,
  isNodeFamilyCommand,
  prependPath,
  resolveMcpCommand,
} from "./runtime-resolver.js";

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function fakeNodeDir(siblings: string[] = []): { dir: string; nodePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rr-"));
  tempRoots.push(dir);
  const nodePath = join(dir, "node");
  writeFileSync(nodePath, "#!/bin/sh\n");
  chmodSync(nodePath, 0o755);
  for (const s of siblings) {
    const p = join(dir, s);
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
  }
  return { dir, nodePath };
}

describe("isNodeFamilyCommand", () => {
  it("recognizes node/npx/npm/corepack and nothing else", () => {
    for (const c of ["node", "npx", "npm", "corepack"]) {
      expect(isNodeFamilyCommand(c)).toBe(true);
    }
    for (const c of ["python", "deno", "bun", "node-x", "/usr/bin/node"]) {
      expect(isNodeFamilyCommand(c)).toBe(false);
    }
  });
});

describe("resolveMcpCommand", () => {
  it("(a) returns an absolute path unchanged with no PATH augmentation", () => {
    const abs = "/opt/thing/bin/server";
    expect(resolveMcpCommand(abs)).toEqual({ command: abs });
  });

  it("(e) returns a non-node bare command unchanged (out of scope)", () => {
    expect(resolveMcpCommand("python")).toEqual({ command: "python" });
  });

  it("(b) resolves `node` to opts.nodePath and augments PATH with its dir", () => {
    const { dir, nodePath } = fakeNodeDir();
    const r = resolveMcpCommand("node", { nodePath });
    expect(r).toEqual({ command: nodePath, pathDir: dir });
  });

  it("(b) resolves `npx` to the sibling next to opts.nodePath", () => {
    const sibling = process.platform === "win32" ? "npx.cmd" : "npx";
    const { dir, nodePath } = fakeNodeDir([sibling]);
    const r = resolveMcpCommand("npx", { nodePath });
    expect(r).toEqual({ command: join(dir, sibling), pathDir: dir });
  });

  it("(d) returns null for a node-family command when no runtime resolves", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("no which");
      },
    }));
    vi.doMock("node:fs", () => ({ existsSync: () => false }));
    const mod = await import("./runtime-resolver.js");
    try {
      expect(mod.resolveMcpCommand("node", { nodePath: "/nope/node" })).toBeNull();
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("Node discovery", () => {
  it("prefers the MCP-specific override", () => {
    const { nodePath } = fakeNodeDir();
    const { nodePath: fallbackPath } = fakeNodeDir();
    vi.stubEnv("PIZZA_MCP_NODE_PATH", nodePath);
    vi.stubEnv("PIZZA_NODE_PATH", fallbackPath);
    try {
      expect(findMcpNode()).toBe(nodePath);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")(
    "finds Node in a per-user Nix profile",
    async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => {
          throw new Error("no which");
        },
      }));
      vi.doMock("node:os", () => ({ homedir: () => "/Users/nix-user" }));
      vi.doMock("node:fs", () => ({
        existsSync: (path: string) =>
          path === "/etc/profiles/per-user/nix-user/bin/node",
      }));
      const mod = await import("./runtime-resolver.js");
      try {
        expect(mod.findSystemNode()).toBe(
          "/etc/profiles/per-user/nix-user/bin/node",
        );
      } finally {
        vi.doUnmock("node:child_process");
        vi.doUnmock("node:os");
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    },
  );
});

describe("prependPath", () => {
  it("returns the dir alone when PATH is empty", () => {
    expect(prependPath("/a/bin", undefined)).toBe("/a/bin");
  });

  it("prepends the dir to an existing PATH", () => {
    const existing = ["/usr/bin", "/bin"].join(delimiter);
    expect(prependPath("/a/bin", existing)).toBe(`/a/bin${delimiter}${existing}`);
  });

  it("does not duplicate a dir already at the front", () => {
    const existing = ["/a/bin", "/usr/bin"].join(delimiter);
    expect(prependPath("/a/bin", existing)).toBe(existing);
  });
});
