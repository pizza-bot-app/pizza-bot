import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "./app-db.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});

describe("LocalFolderStore", () => {
  it("persists stable virtual mounts and their access mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pizza-local-folders-"));
    roots.push(root);
    const file = join(root, "app.sqlite");

    const first = openAppDatabase(file);
    expect(
      first.localFolders.create({
        id: "project-files",
        label: "Project files",
        path: join(root, "project"),
        readOnly: false,
      }),
    ).toMatchObject({
      id: "project-files",
      label: "Project files",
      virtualPath: "/local/project-files",
      readOnly: false,
    });
    first.close();

    const second = openAppDatabase(file);
    expect(second.localFolders.list()).toHaveLength(1);
    expect(second.localFolders.hasId("project-files")).toBe(true);
    expect(second.localFolders.delete("project-files")).toBe(true);
    expect(second.localFolders.list()).toEqual([]);
    second.close();
  });
});
