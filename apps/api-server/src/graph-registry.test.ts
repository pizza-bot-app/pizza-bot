import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGraphSpec, type GraphSpec } from "@pizza-bot/core";

const renameFailures: string[] = [];
const renames = { inFlight: 0, maxInFlight: 0 };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const code = renameFailures.shift();
      if (code) throw Object.assign(new Error(`${code}: rename`), { code });
      renames.maxInFlight = Math.max(renames.maxInFlight, ++renames.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await actual.rename(from, to);
      } finally {
        renames.inFlight--;
      }
    }),
  };
});

const { GraphRegistry } = await import("./graph-registry.js");

const dirs: string[] = [];
afterEach(() => {
  renameFailures.length = 0;
  renames.maxInFlight = 0;
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

  it("never renames two saves of one graph onto its file at once", async () => {
    const graphs = registry();
    const names = Array.from({ length: 20 }, (_, i) => `Digest ${i}`);
    renameFailures.push("EPERM");
    await Promise.all(names.map((name) => graphs.put({ ...spec, name })));
    expect(renames.maxInFlight).toBe(1);
    expect(names).toContain((await graphs.get("digest"))?.name);
    expect(fs.readdirSync(graphs.dir)).toEqual(["digest.json"]);
  });

  it("keeps saving a graph after one of its saves fails", async () => {
    const graphs = registry();
    renameFailures.push("ENOSPC");
    const results = await Promise.allSettled(["A", "B"].map((name) => graphs.put({ ...spec, name })));
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const saved = results.findIndex((r) => r.status === "fulfilled");
    expect(await graphs.get("digest")).toMatchObject({ name: ["A", "B"][saved] });
    await graphs.put({ ...spec, name: "After" });
    expect(await graphs.get("digest")).toMatchObject({ name: "After" });
    expect(fs.readdirSync(graphs.dir)).toEqual(["digest.json"]);
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
