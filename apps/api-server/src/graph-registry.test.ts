import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGraphSpec, type GraphSpec } from "@pizza-bot/core";

const renameFailures: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const code = renameFailures.shift();
      if (code) throw Object.assign(new Error(`${code}: rename`), { code });
      return actual.rename(from, to);
    }),
  };
});

const { GraphRegistry } = await import("./graph-registry.js");

const dirs: string[] = [];
afterEach(() => {
  renameFailures.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function registry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-graph-registry-"));
  dirs.push(dir);
  return new GraphRegistry(path.join(dir, "graphs"));
}

const raw = {
  id: "digest",
  name: "Digest",
  nodes: [{ id: "greet", type: "transform", set: { text: "hi {{input.who}}" } }],
  edges: [{ from: "start", to: "greet" }, { from: "greet", to: "end" }],
};
const parsed = parseGraphSpec(raw);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const spec: GraphSpec = parsed.spec;

describe("GraphRegistry", () => {
  it("retries a save whose rename hits a transient Windows lock", async () => {
    const graphs = registry();
    renameFailures.push("EPERM", "EBUSY");
    await graphs.put(spec);
    expect(await graphs.get("digest")).toMatchObject({ name: "Digest" });
    expect(fs.readdirSync(graphs.dir)).toEqual(["digest.json"]);
  });

  it("removes its temp file when the rename keeps failing", async () => {
    const graphs = registry();
    renameFailures.push(...Array<string>(5).fill("EPERM"));
    await expect(graphs.put(spec)).rejects.toMatchObject({ code: "EPERM" });
    expect(fs.readdirSync(graphs.dir)).toEqual([]);
  });

  it("does not retry other rename errors", async () => {
    const graphs = registry();
    renameFailures.push("ENOSPC");
    await expect(graphs.put(spec)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(renameFailures).toEqual([]);
    expect(fs.readdirSync(graphs.dir)).toEqual([]);
  });

  it("loads a spec saved with a UTF-8 byte-order mark", async () => {
    const graphs = registry();
    fs.mkdirSync(graphs.dir, { recursive: true });
    fs.writeFileSync(path.join(graphs.dir, "digest.json"), `\uFEFF${JSON.stringify(raw)}`, "utf8");
    expect(await graphs.get("digest")).toMatchObject({ name: "Digest" });
    expect((await graphs.list()).invalid).toEqual([]);
  });
});
