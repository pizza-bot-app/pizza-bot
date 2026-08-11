import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./index.js";
import { AgentHost } from "./agent-host.js";

describe("memory routes: GET/POST/PUT/DELETE /memories", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "route-mem-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "route-mem-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
    host.settings.patch({ enableMemories: true });
    await host.reloadSettings();
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    app.request("/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const put = (id: string, body: unknown) =>
    app.request(`/memories/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const listIds = async () =>
    ((await (await app.request("/memories")).json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);

  it("creates a memory: writes the .md file and lists it", async () => {
    const res = await post({ id: "prefs", content: "# Preferences\nLikes thin crust." });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; content: string };
    expect(created.id).toBe("prefs");

    expect(existsSync(join(dataRoot, "memories", "prefs.md"))).toBe(true);
    expect(readFileSync(join(dataRoot, "memories", "prefs.md"), "utf8")).toContain("thin crust");
    expect(await listIds()).toContain("prefs");
    const list = (await (await app.request("/memories")).json()) as {
      memories: Array<{ id: string; preview: string }>;
    };
    expect(list.memories.find((m) => m.id === "prefs")?.preview).toBe("Preferences");
  });

  it("reads one memory's full content; 404s an unknown id", async () => {
    await post({ id: "note", content: "hello world" });
    const ok = await app.request("/memories/note");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { content: string }).content).toBe("hello world");

    expect((await app.request("/memories/missing")).status).toBe(404);
  });

  it("rejects an invalid id and a duplicate create", async () => {
    expect((await post({ id: "../escape", content: "x" })).status).toBe(400);
    await post({ id: "dup", content: "first" });
    expect((await post({ id: "dup", content: "second" })).status).toBe(409);
    expect(((await (await app.request("/memories/dup")).json()) as { content: string }).content).toBe("first");
  });

  it("PUT replaces content (create-or-replace) and is idempotent", async () => {
    const created = await put("evolving", { content: "v1" });
    expect(created.status).toBe(200);
    expect(existsSync(join(dataRoot, "memories", "evolving.md"))).toBe(true);
    await put("evolving", { content: "v2" });
    expect(readFileSync(join(dataRoot, "memories", "evolving.md"), "utf8")).toBe("v2");
  });

  it("deletes a memory", async () => {
    await post({ id: "temp", content: "delete me" });
    expect(await listIds()).toContain("temp");
    const del = await app.request("/memories/temp", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(join(dataRoot, "memories", "temp.md"))).toBe(false);
    expect(await listIds()).not.toContain("temp");
  });

  it("stops exposing existing memories as soon as the setting is disabled", async () => {
    await post({ id: "private", content: "must not leak" });
    host.settings.patch({ enableMemories: false });

    expect(await listIds()).toEqual([]);
    expect((await app.request("/memories/private")).status).toBe(409);
    expect((await put("private", { content: "changed" })).status).toBe(409);
    expect((await app.request("/memories/private", { method: "DELETE" })).status).toBe(409);
    expect(readFileSync(join(dataRoot, "memories", "private.md"), "utf8")).toBe("must not leak");
  });
});
