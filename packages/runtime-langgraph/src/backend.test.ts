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
    const screenshot = "Screenshot 2026-08-03 at 4.06.57\u202fPM.png";
    const screenshotPath =
      "/local/notes/Screenshot 2026-08-03 at 4.06.57%E2%80%AFPM.png";
    writeFileSync(join(dir, screenshot), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(dir, "100% ready.txt"), "ordinary text", "utf8");
    writeFileSync(join(dir, "ambiguous name.txt"), "ordinary space", "utf8");
    writeFileSync(
      join(dir, "ambiguous\u202fname.txt"),
      "narrow no-break space",
      "utf8",
    );
    const unicodeDirectory = "R\u00e9sum\u00e9\u202ffiles";
    mkdirSync(join(dir, unicodeDirectory));
    writeFileSync(join(dir, unicodeDirectory, "details.md"), "nested", "utf8");
    if (process.platform !== "win32") {
      writeFileSync(join(dir, String.raw`slash\name.txt`), "backslash", "utf8");
    }
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
    const listedPaths = (await backend.ls("/local/notes/")).files?.map(
      (entry) => entry.path,
    );
    expect(listedPaths).toContain(screenshotPath);
    expect(listedPaths).toContain("/local/notes/100%25 ready.txt");
    expect(listedPaths).toContain(
      "/local/notes/R%C3%A9sum%C3%A9%E2%80%AFfiles/",
    );
    if (process.platform !== "win32") {
      expect(listedPaths).toContain("/local/notes/slash%5Cname.txt");
    }
    expect(
      await backend.read(screenshotPath),
    ).toMatchObject({
      content: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
    });
    expect(
      (await backend.read("/local/notes/100%25 ready.txt")).content,
    ).toContain("ordinary text");
    expect(
      (
        await backend.read(
          "/local/notes/R%C3%A9sum%C3%A9%E2%80%AFfiles/details.md",
        )
      ).content,
    ).toContain("nested");
    if (process.platform !== "win32") {
      expect(
        (await backend.read("/local/notes/slash%5Cname.txt")).content,
      ).toContain("backslash");
    }
    expect(
      (
        await backend.glob("Screenshot 2026-08-03*", "/local/notes")
      ).files?.map((entry) => entry.path),
    ).toContain(screenshotPath);
    expect(
      (
        await backend.grep("ordinary text", "/local/notes")
      ).matches?.map((entry) => entry.path),
    ).toContain("/local/notes/100%25 ready.txt");
    expect(
      (
        await backend.read(
          "/local/notes/Screenshot 2026-08-03 at 4.06.57 PM.png",
        )
      ).content,
    ).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(
      (
        await backend.read(
          "/local/notes/ambiguous%E2%80%87name.txt",
        )
      ).error,
    ).toContain("no such file or directory");
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

  it("allows every mutation only while a folder has write access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-folder-writable-"));
    const canonicalDir = realpathSync(dir);
    let readOnly = false;
    const backend = buildBackend({
      localFolders: () => [{
        id: "workspace",
        label: "Workspace",
        path: canonicalDir,
        virtualPath: "/local/workspace",
        readOnly,
        createdAt: new Date().toISOString(),
      }],
    }) as CompositeBackend;

    expect(
      await backend.write("/local/workspace/nested/notes.md", "first"),
    ).toMatchObject({ path: "/local/workspace/nested/notes.md" });
    expect(readFileSync(join(dir, "nested", "notes.md"), "utf8")).toBe("first");

    expect(
      await backend.write(
        "/local/workspace/r%C3%A9sum%C3%A9%20notes.txt",
        "encoded",
      ),
    ).toMatchObject({
      path: "/local/workspace/r%C3%A9sum%C3%A9 notes.txt",
    });
    expect(readFileSync(join(dir, "r\u00e9sum\u00e9 notes.txt"), "utf8")).toBe(
      "encoded",
    );

    expect(
      await backend.edit(
        "/local/workspace/r%C3%A9sum%C3%A9 notes.txt",
        "encoded",
        "updated",
      ),
    ).toMatchObject({
      path: "/local/workspace/r%C3%A9sum%C3%A9 notes.txt",
      occurrences: 1,
    });
    expect(readFileSync(join(dir, "r\u00e9sum\u00e9 notes.txt"), "utf8")).toBe(
      "updated",
    );

    expect(
      await backend.uploadFiles?.([
        [
          "/local/workspace/nested/100%25-upload.bin",
          new TextEncoder().encode("binary"),
        ],
      ]),
    ).toEqual([
      {
        path: "/local/workspace/nested/100%25-upload.bin",
        error: null,
      },
    ]);
    expect(readFileSync(join(dir, "nested", "100%-upload.bin"), "utf8")).toBe(
      "binary",
    );
    expect(
      await backend.downloadFiles?.([
        "/local/workspace/nested/100%25-upload.bin",
      ]),
    ).toMatchObject([
      {
        path: "/local/workspace/nested/100%25-upload.bin",
        error: null,
      },
    ]);

    expect(
      await backend.delete("/local/workspace/r%C3%A9sum%C3%A9 notes.txt"),
    ).toMatchObject({
      path: "/local/workspace/r%C3%A9sum%C3%A9 notes.txt",
    });
    expect(() =>
      readFileSync(join(dir, "r\u00e9sum\u00e9 notes.txt"), "utf8")
    ).toThrow();
    expect(
      (await backend.write("/local/workspace/%2E%2E/outside.md", "no"))
        .error,
    ).toContain("not allowed");

    readOnly = true;
    expect(
      (await backend.write("/local/workspace/blocked.md", "no")).error,
    ).toContain("read-only");
    expect(
      (
        await backend.edit(
          "/local/workspace/nested/100%25-upload.bin",
          "binary",
          "changed",
        )
      ).error,
    ).toContain("read-only");
    expect(
      (
        await backend.delete(
          "/local/workspace/nested/100%25-upload.bin",
        )
      ).error,
    ).toContain("read-only");
    expect(
      await backend.uploadFiles?.([
        [
          "/local/workspace/blocked.bin",
          new TextEncoder().encode("no"),
        ],
      ]),
    ).toEqual([
      {
        path: "/local/workspace/blocked.bin",
        error: "permission_denied",
      },
    ]);
    expect(readFileSync(join(dir, "nested", "100%-upload.bin"), "utf8")).toBe(
      "binary",
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
          readOnly: false,
          createdAt: new Date().toISOString(),
        }],
      }) as CompositeBackend;

      expect((await backend.read("/local/root/linked/secret.txt")).error).toContain(
        "not allowed",
      );
      expect((await backend.read("/local/root/linked/missing.txt")).error).toContain(
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
      expect(
        (await backend.write("/local/root/linked/secret.txt", "changed")).error,
      ).toContain("not allowed");
      expect(
        await backend.uploadFiles?.([
          [
            "/local/root/linked/upload.bin",
            new TextEncoder().encode("changed"),
          ],
        ]),
      ).toEqual([
        {
          path: "/local/root/linked/upload.bin",
          error: "permission_denied",
        },
      ]);
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe(
        "not approved",
      );

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
