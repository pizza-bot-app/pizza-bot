import { describe, expect, it } from "vitest";
import { CompositeBackend, StateBackend } from "deepagents";
import { buildBackend } from "./backend.js";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function removeDir(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

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

  it("mounts approved local folders read-only and revokes them live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-folder-backend-"));
    writeFileSync(join(dir, "notes.md"), "approved notes", "utf8");
    const canonicalDir = realpathSync(dir);
    let folders = [{
      id: "notes",
      label: "Notes",
      path: canonicalDir,
      virtualPath: "/local/notes",
      readOnly: true as const,
      createdAt: new Date().toISOString(),
    }];
    const backend = buildBackend({
      localFolders: () => folders,
    }) as CompositeBackend;

    expect(backend.routePrefixes).toEqual(["/local/"]);
    expect(await backend.ls("/local/")).toMatchObject({
      files: [{ path: "/local/notes/", is_dir: true }],
    });
    expect((await backend.read("/local/notes/notes.md")).content).toContain(
      "approved notes",
    );
    expect((await backend.write("/local/notes/new.md", "no")).error).toContain(
      "read-only",
    );
    expect((await backend.edit("/local/notes/notes.md", "notes", "data")).error).toContain(
      "read-only",
    );
    expect((await backend.read("/local/notes/../outside.md")).error).toContain(
      "not allowed",
    );

    folders = [];
    expect((await backend.read("/local/notes/notes.md")).error).toContain(
      "not allowed",
    );
    removeDir(dir);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink that escapes an approved folder",
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "local-folder-symlink-"));
      const root = join(parent, "root");
      const outside = join(parent, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "not approved", "utf8");
      symlinkSync(outside, join(root, "linked"), "dir");
      const canonicalRoot = realpathSync(root);
      const backend = buildBackend({
        localFolders: () => [{
          id: "root",
          label: "Root",
          path: canonicalRoot,
          virtualPath: "/local/root",
          readOnly: true,
          createdAt: new Date().toISOString(),
        }],
      }) as CompositeBackend;

      expect((await backend.read("/local/root/linked/secret.txt")).error).toContain(
        "not allowed",
      );
      expect(
        (await backend.ls("/local/root/")).files?.map((entry) => entry.path),
      ).not.toContain("/local/root/linked/");
      expect(
        (await backend.glob("**/*", "/local/root/")).files?.map((entry) =>
          entry.path
        ),
      ).not.toContain("/local/root/linked/secret.txt");

      removeDir(root);
      symlinkSync(outside, root, "dir");
      expect(
        (await backend.grep("not approved", "/local/root/")).error,
      ).toContain(
        "not allowed",
      );
      expect((await backend.glob("**/*", "/local/root/")).error).toContain(
        "not allowed",
      );
      expect((await backend.read("/local/root/secret.txt")).error).toContain(
        "not allowed",
      );
      removeDir(parent);
    },
  );

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
    removeDir(dir);
  });
});
