import { describe, expect, it } from "vitest";
import { CompositeBackend, StateBackend } from "deepagents";
import { buildBackend } from "./backend.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildBackend", () => {
  it("returns a bare StateBackend when no memories directory is provided", () => {
    const backend = buildBackend({});
    expect(backend).toBeInstanceOf(StateBackend);
  });

  it("wraps state in a composite that routes /memories/ to the filesystem", () => {
    const backend = buildBackend({ memoriesDir: "/srv/pizza-bot/memories" });
    expect(CompositeBackend.isInstance(backend)).toBe(true);
    expect((backend as CompositeBackend).routePrefixes).toEqual(["/memories/"]);
  });

  it("blocks every durable memory operation while the live gate is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-backend-"));
    writeFileSync(join(dir, "preferences.md"), "likes thin crust", "utf8");
    let enabled = false;
    const backend = buildBackend({
      memoriesDir: dir,
      memoryEnabled: () => enabled,
    }) as CompositeBackend;

    expect((await backend.ls("/memories/")).error).toContain("disabled");
    expect((await backend.read("/memories/preferences.md")).error).toContain("disabled");
    expect((await backend.grep("thin crust", "/memories/")).error).toContain("disabled");
    expect((await backend.glob("*.md", "/memories/")).error).toContain("disabled");
    expect((await backend.write("/memories/preferences.md", "changed")).error).toContain("disabled");
    expect((await backend.edit("/memories/preferences.md", "thin", "thick")).error).toContain("disabled");
    expect((await backend.delete("/memories/preferences.md")).error).toContain("disabled");
    expect(await backend.uploadFiles?.([
      ["/memories/new.md", new TextEncoder().encode("new")],
    ])).toEqual([{ path: "/memories/new.md", error: "permission_denied" }]);
    expect(await backend.downloadFiles?.(["/memories/preferences.md"])).toEqual([
      {
        path: "/memories/preferences.md",
        content: null,
        error: "permission_denied",
      },
    ]);
    expect(readFileSync(join(dir, "preferences.md"), "utf8")).toBe("likes thin crust");

    enabled = true;
    expect((await backend.read("/memories/preferences.md")).content).toContain("thin crust");
    rmSync(dir, { recursive: true, force: true });
  });
});
