import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAppDatabase } from "./app-db.js";

const apps: ReturnType<typeof openAppDatabase>[] = [];
const directories: string[] = [];

function openApp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-folders-"));
  directories.push(directory);
  const app = openAppDatabase(path.join(directory, "app.sqlite"));
  apps.push(app);
  return app;
}

afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FolderStore", () => {
  it("creates, orders, renames, and publishes folder changes", () => {
    const app = openApp();
    let changes = 0;
    const unsubscribe = app.folders.subscribe(() => changes++);

    app.folders.create({ folderId: "later", name: "Later", sortOrder: 2 });
    app.folders.create({ folderId: "first", name: "First", sortOrder: 1 });
    expect(app.folders.list().map((folder) => folder.folderId)).toEqual([
      "first",
      "later",
    ]);
    expect(app.folders.update("later", { name: "Projects" })?.name).toBe("Projects");
    expect(app.folders.update("missing", { name: "Missing" })).toBeUndefined();
    expect(changes).toBe(3);

    unsubscribe();
  });

  it("keeps folder names unique without regard to case", () => {
    const app = openApp();
    app.folders.create({ folderId: "one", name: "Projects" });
    expect(() =>
      app.folders.create({ folderId: "two", name: "projects" }),
    ).toThrow();
  });

  it("moves threads to unfiled when their folder is deleted", () => {
    const app = openApp();
    app.folders.create({ folderId: "projects", name: "Projects" });
    app.threadStore.create({ threadId: "thread-1", folderId: "projects" });

    expect(app.folders.delete("projects")).toBe(true);
    expect(app.threadStore.get("thread-1")?.folderId).toBeUndefined();
    expect(app.folders.delete("projects")).toBe(false);
  });
});
