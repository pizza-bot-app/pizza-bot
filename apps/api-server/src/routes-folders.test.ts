import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAppDatabase } from "@pizza-bot/storage";
import { folderRoutes } from "./routes-folders.js";

const apps: ReturnType<typeof openAppDatabase>[] = [];
const directories: string[] = [];

function testApp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-folder-routes-"));
  directories.push(directory);
  const appDb = openAppDatabase(path.join(directory, "app.sqlite"));
  apps.push(appDb);
  const host = {
    folderStore: appDb.folders,
  } as unknown as import("./agent-host.js").AgentHost;
  return { routes: folderRoutes(host), appDb };
}

afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("folderRoutes", () => {
  it("creates, lists, renames, and deletes folders", async () => {
    const { routes } = testApp();
    const created = await routes.request("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Projects  " }),
    });
    expect(created.status).toBe(201);
    const folder = (await created.json()) as { folderId: string; name: string };
    expect(folder.name).toBe("Projects");

    expect(await (await routes.request("/folders")).json()).toEqual([
      expect.objectContaining({ folderId: folder.folderId, name: "Projects" }),
    ]);

    const renamed = await routes.request(`/folders/${folder.folderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research" }),
    });
    expect(await renamed.json()).toEqual(
      expect.objectContaining({ folderId: folder.folderId, name: "Research" }),
    );

    const deleted = await routes.request(`/folders/${folder.folderId}`, {
      method: "DELETE",
    });
    expect(await deleted.json()).toEqual({ deleted: true });
  });

  it("rejects invalid and duplicate names", async () => {
    const { routes } = testApp();
    const blank = await routes.request("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " " }),
    });
    expect(blank.status).toBe(400);

    await routes.request("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Projects" }),
    });
    const duplicate = await routes.request("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "projects" }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("preserves threads as unfiled when deleting a folder", async () => {
    const { routes, appDb } = testApp();
    appDb.folders.create({ folderId: "folder-1", name: "Projects" });
    appDb.threadStore.create({ threadId: "thread-1", folderId: "folder-1" });

    await routes.request("/folders/folder-1", { method: "DELETE" });
    expect(appDb.threadStore.get("thread-1")?.folderId).toBeUndefined();
  });
});
