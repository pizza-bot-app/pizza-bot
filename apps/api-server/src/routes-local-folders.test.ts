import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
// `.native` mirrors the routes' canonicalization; the JS `realpathSync` keeps
// Windows 8.3 short names that the native one expands.
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
        path: realpathSync.native(allowed),
      }],
    });
    expect(
      await (
        await app.request(
          `/local-folders/browse?path=${encodeURIComponent(allowed)}`,
        )
      ).json(),
    ).toEqual({
      currentPath: realpathSync.native(allowed),
      parentPath: null,
      directories: [{ name: "child", path: realpathSync.native(child) }],
    });
    expect(
      await (
        await app.request(
          `/local-folders/browse?path=${encodeURIComponent(child)}`,
        )
      ).json(),
    ).toMatchObject({
      currentPath: realpathSync.native(child),
      parentPath: realpathSync.native(allowed),
      directories: [{ name: "nested", path: realpathSync.native(nested) }],
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

  it("accepts data-root browse paths and rejects inaccessible roots at startup", () => {
    expect(() =>
      buildApp(host, {
        allowLocalFolderConfiguration: true,
        localFolderBrowseRoots: [dataRoot],
      })
    ).not.toThrow();
    expect(() =>
      buildApp(host, {
        allowLocalFolderConfiguration: true,
        localFolderBrowseRoots: [join(allowed, "missing")],
      })
    ).toThrow("directory is not accessible");
  });

  it("defaults grants to read-only and accepts explicit write access", async () => {
    const app = buildApp(host, { allowLocalFolderConfiguration: true });
    const project = join(allowed, "Project Files");
    const writable = join(allowed, "Writable");
    mkdirSync(project);
    mkdirSync(writable);
    const response = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project, label: "Ignored label" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: "project-files",
      label: "Project Files",
      path: realpathSync.native(project),
      virtualPath: "/local/project-files",
      readOnly: true,
    });

    const writableResponse = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: writable, readOnly: false }),
    });
    expect(writableResponse.status).toBe(201);
    expect(await writableResponse.json()).toMatchObject({
      id: "writable",
      label: "Writable",
      readOnly: false,
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
    expect(
      await (
        await app.request("/local-folders/writable", { method: "DELETE" })
      ).json(),
    ).toEqual({ deleted: true });
    expect(host.localFolders.list()).toEqual([]);
  });

  it("allows only additive overlaps that narrow write access", async () => {
    const app = buildApp(host, { allowLocalFolderConfiguration: true });
    const parent = join(allowed, "parent");
    const writableChild = join(parent, "writable-child");
    const writableGrandchild = join(writableChild, "grandchild");
    const readOnlySibling = join(parent, "read-only-sibling");
    const otherParent = join(allowed, "other-parent");
    const otherChild = join(otherParent, "child");
    mkdirSync(writableGrandchild, { recursive: true });
    mkdirSync(readOnlySibling);
    mkdirSync(otherChild, { recursive: true });

    const create = (folderPath: string, readOnly: boolean) =>
      app.request("/local-folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folderPath, readOnly }),
      });

    expect((await create(parent, true)).status).toBe(201);
    expect((await create(writableChild, false)).status).toBe(201);

    const redundant = await create(writableGrandchild, false);
    expect(redundant.status).toBe(409);
    expect(await redundant.json()).toMatchObject({
      error: "overlapping_grant",
      detail: expect.stringContaining("grants are additive"),
    });

    const redundantReadOnly = await create(readOnlySibling, true);
    expect(redundantReadOnly.status).toBe(409);

    const misleadingChild = await create(writableGrandchild, true);
    expect(misleadingChild.status).toBe(409);
    expect(await misleadingChild.json()).toMatchObject({
      error: "overlapping_grant",
      detail: expect.stringContaining("writable parent"),
    });

    expect((await create(otherChild, false)).status).toBe(201);
    expect((await create(otherParent, true)).status).toBe(201);
  });

  it("warns before granting paths that overlap the Pizza Bot data root", async () => {
    const app = buildApp(host, { allowLocalFolderConfiguration: true });
    const nested = join(dataRoot, "nested");
    mkdirSync(nested);

    for (const folderPath of [dataRoot, nested, join(dataRoot, "..")]) {
      const response = await app.request("/local-folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folderPath, readOnly: false }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "data_root_access_requires_confirmation",
      });
    }

    const confirmedReadOnly = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: dataRoot,
        acknowledgeDataRootAccess: true,
      }),
    });
    expect(confirmedReadOnly.status).toBe(201);
    const readOnlyFolder = await confirmedReadOnly.json() as {
      id: string;
      path: string;
      readOnly: boolean;
    };
    expect(readOnlyFolder).toMatchObject({
      path: realpathSync.native(dataRoot),
      readOnly: true,
    });

    await app.request(`/local-folders/${readOnlyFolder.id}`, { method: "DELETE" });
    const confirmedWritable = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: join(dataRoot, ".."),
        readOnly: false,
        acknowledgeDataRootAccess: true,
      }),
    });
    expect(confirmedWritable.status).toBe(201);
    expect(await confirmedWritable.json()).toMatchObject({ readOnly: false });
  });

  it("rejects relative, missing, file, and invalid-access paths", async () => {
    const app = buildApp(host, { allowLocalFolderConfiguration: true });
    const file = join(allowed, "file.txt");
    writeFileSync(file, "not a directory", "utf8");
    for (const folderPath of ["relative", join(allowed, "missing"), file]) {
      const response = await app.request("/local-folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      expect(response.status).toBe(400);
    }

    const invalidAccess = await app.request("/local-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: allowed, readOnly: "false" }),
    });
    expect(invalidAccess.status).toBe(400);
  });
});
