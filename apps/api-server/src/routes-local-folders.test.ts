import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "./agent-host.js";
import { buildApp } from "./index.js";

describe("local folder routes", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let allowed: string;
  let host: AgentHost;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "local-folder-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "local-folder-plugins-"));
    allowed = mkdtempSync(join(tmpdir(), "local-folder-allowed-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
  });

  afterEach(async () => {
    await host.close();
    for (const root of [dataRoot, pluginsDir, allowed]) {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });

  it("is read-only by default for standalone backends", async () => {
    const app = buildApp(host);
    expect(await (await app.request("/local-folders")).json()).toEqual({
      folders: [],
      configurable: false,
      browseAvailable: false,
    });
    expect((await app.request("/local-folders/browse")).status).toBe(403);
    const response = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: allowed }),
    });
    expect(response.status).toBe(403);
  });

  it("browses only directories beneath operator-configured roots", async () => {
    const child = join(allowed, "child");
    const nested = join(child, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(allowed, "file.txt"), "not a folder", "utf8");
    const app = buildApp(host, {
      allowLocalFolderConfiguration: true,
      localFolderBrowseRoots: [allowed],
    });

    expect(await (await app.request("/local-folders")).json()).toMatchObject({
      configurable: true,
      browseAvailable: true,
    });
    expect(await (await app.request("/local-folders/browse")).json()).toEqual({
      currentPath: null,
      parentPath: null,
      directories: [{
        name: allowed.split(/[\\/]/).at(-1),
        path: realpathSync(allowed),
      }],
    });
    expect(
      await (
        await app.request(
          `/local-folders/browse?path=${encodeURIComponent(allowed)}`,
        )
      ).json(),
    ).toEqual({
      currentPath: realpathSync(allowed),
      parentPath: null,
      directories: [{ name: "child", path: realpathSync(child) }],
    });
    expect(
      await (
        await app.request(
          `/local-folders/browse?path=${encodeURIComponent(child)}`,
        )
      ).json(),
    ).toMatchObject({
      currentPath: realpathSync(child),
      parentPath: realpathSync(allowed),
      directories: [{ name: "nested", path: realpathSync(nested) }],
    });
    expect(
      (
        await app.request(
          `/local-folders/browse?path=${encodeURIComponent(pluginsDir)}`,
        )
      ).status,
    ).toBe(403);
  });

  it.skipIf(process.platform === "win32")(
    "hides directory symlinks from backend browsing",
    async () => {
      const outside = join(pluginsDir, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(allowed, "linked"), "dir");
      const app = buildApp(host, {
        allowLocalFolderConfiguration: true,
        localFolderBrowseRoots: [allowed],
      });
      const result = await (
        await app.request(
          `/local-folders/browse?path=${encodeURIComponent(allowed)}`,
        )
      ).json() as { directories: Array<{ name: string }> };
      expect(result.directories).toEqual([]);
    },
  );

  it("rejects protected or inaccessible browse roots at startup", () => {
    expect(() =>
      buildApp(host, {
        allowLocalFolderConfiguration: true,
        localFolderBrowseRoots: [dataRoot],
      })
    ).toThrow("cannot include the Pizza Bot data directory");
    expect(() =>
      buildApp(host, {
        allowLocalFolderConfiguration: true,
        localFolderBrowseRoots: [join(allowed, "missing")],
      })
    ).toThrow("directory is not accessible");
  });

  it("adds canonical individual folders and removes them", async () => {
    const app = buildApp(host, { allowLocalFolderConfiguration: true });
    const project = join(allowed, "Project Files");
    mkdirSync(project);
    const response = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project, label: "Ignored label" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: "project-files",
      label: "Project Files",
      path: realpathSync(project),
      virtualPath: "/local/project-files",
      readOnly: true,
    });

    const duplicate = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    expect(duplicate.status).toBe(409);

    expect(
      await (
        await app.request("/local-folders/project-files", { method: "DELETE" })
      ).json(),
    ).toEqual({ deleted: true });
    expect(host.localFolders.list()).toEqual([]);
  });

  it("rejects relative, missing, file, and Pizza Bot data paths", async () => {
    const app = buildApp(host, { allowLocalFolderConfiguration: true });
    const nested = join(dataRoot, "nested");
    const file = join(allowed, "file.txt");
    mkdirSync(nested);
    writeFileSync(file, "not a directory", "utf8");
    for (const folderPath of [
      "relative",
      join(allowed, "missing"),
      file,
      dataRoot,
      nested,
    ]) {
      const response = await app.request("/local-folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      expect(response.status).toBe(400);
    }

    const protectedParent = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(dataRoot, "..") }),
    });
    expect(protectedParent.status).toBe(400);
  });
});
