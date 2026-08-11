import { describe, expect, it, vi } from "vitest";
import {
  ContributionRegistry,
  pluginManifestSchema,
  type LoadedPlugins,
} from "@pizza-bot/plugin-sdk";
import type { AgentHost } from "./agent-host.js";
import { pluginRoutes } from "./routes-plugins.js";
import { storedZip } from "./test-utils/stored-zip.js";
import { MAX_PLUGIN_ARCHIVE_BYTES } from "./plugin-import.js";
import { multipartRequestLimit } from "./request-limits.js";

function uploadForm(bytes: Uint8Array, filename = "plugin.zip"): FormData {
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type: "application/zip" }));
  return form;
}

describe("plugin routes", () => {
  it("offers an explicit runtime reload hook for installers", async () => {
    let calls = 0;
    const host = {
      reloadPlugins: async () => {
        calls++;
      },
    } as unknown as AgentHost;

    const response = await pluginRoutes(host).request("/plugins/reload", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reloaded: true });
    expect(calls).toBe(1);
  });

  it("lists manifest metadata and imported contribution counts", async () => {
    const registry = new ContributionRegistry();
    registry.registerPlugin("external-bundle");
    registry.registerMcpServer(
      "external-bundle",
      "/addons/mcp/mail",
      "mail",
      { command: "node", args: ["/addons/mcp/mail/server.js"] },
    );
    registry.registerSkill(
      "external-bundle",
      "/addons/skill/mail",
      "mail-assistant",
      "/addons/skill/mail/SKILL.md",
    );
    const plugins = {
      registry,
      manifests: [
        pluginManifestSchema.parse({
          name: "external-bundle",
          displayName: "External Bundle",
          version: "1.2.3",
          description: "External integrations.",
          author: { name: "External Publisher" },
        }),
      ],
      tools: {},
      catalog: {},
      skills: new Map(),
      materializations: {
        "external-bundle": {
          state: "synced",
          sourceRoots: ["/addons"],
          lastSyncedAt: "2026-08-10T00:00:00.000Z",
        },
      },
    } satisfies LoadedPlugins;
    const host = {
      whenReady: async () => {},
      plugins,
      pluginIsInstalled: async () => false,
    } as unknown as AgentHost;

    const response = await pluginRoutes(host).request("/plugins");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plugins: [
        {
          name: "external-bundle",
          displayName: "External Bundle",
          version: "1.2.3",
          description: "External integrations.",
          author: "External Publisher",
          removable: false,
          contributions: {
            skills: 1,
            mcpServers: 1,
          },
          materialization: {
            state: "synced",
            sourceRoots: ["/addons"],
            lastSyncedAt: "2026-08-10T00:00:00.000Z",
          },
        },
      ],
    });
  });

  it("refreshes a materialized plugin and returns its resulting status", async () => {
    const reloadPlugins = vi.fn(async () => {});
    const host = {
      reloadPlugins,
      plugins: {
        materializations: {
          "generated-tools": {
            state: "stale",
            sourceRoots: ["/addons"],
            detail: "source unavailable",
          },
        },
      },
    } as unknown as AgentHost;

    const response = await pluginRoutes(host).request(
      "/plugins/generated-tools/refresh",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "generated-tools",
      materialization: {
        state: "stale",
        sourceRoots: ["/addons"],
        detail: "source unavailable",
      },
    });
    expect(reloadPlugins).toHaveBeenCalledWith("manual");
  });

  it("returns 404 when refreshing a non-materialized plugin", async () => {
    const host = {
      reloadPlugins: async () => {},
      plugins: { materializations: {} },
    } as unknown as AgentHost;

    const response = await pluginRoutes(host).request(
      "/plugins/plain/refresh",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
  });

  it("installs a plugin ZIP and reports the installed name", async () => {
    const installed: unknown[] = [];
    const host = {
      pluginsInstallDirectory: async () => "/data/plugins",
      pluginIsInstalled: async () => false,
      installPlugin: async (plugin: unknown) => {
        installed.push(plugin);
      },
    } as unknown as AgentHost;

    const archive = storedZip([
      { path: "weather/.claude-plugin/plugin.json", content: JSON.stringify({ name: "weather" }) },
    ]);
    const response = await pluginRoutes(host).request("/plugins/import", {
      method: "POST",
      body: uploadForm(archive),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: "weather" });
    expect(installed).toHaveLength(1);
  });

  it("rejects installing over an existing plugin", async () => {
    const host = {
      pluginsInstallDirectory: async () => "/data/plugins",
      pluginIsInstalled: async () => true,
      installPlugin: async () => {
        throw new Error("should not be called");
      },
    } as unknown as AgentHost;

    const archive = storedZip([
      { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name: "weather" }) },
    ]);
    const response = await pluginRoutes(host).request("/plugins/import", {
      method: "POST",
      body: uploadForm(archive),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "already_exists" });
  });

  it("refuses import when plugins are disabled", async () => {
    const host = { pluginsInstallDirectory: async () => false } as unknown as AgentHost;
    const response = await pluginRoutes(host).request("/plugins/import", {
      method: "POST",
      body: uploadForm(storedZip([{ path: ".claude-plugin/plugin.json", content: "{}" }])),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "plugins_disabled" });
  });

  it("rejects oversized requests before parsing multipart data", async () => {
    const host = {
      pluginsInstallDirectory: async () => "/data/plugins",
    } as unknown as AgentHost;
    const response = await pluginRoutes(host).request("/plugins/import", {
      method: "POST",
      headers: {
        "content-length": String(multipartRequestLimit(MAX_PLUGIN_ARCHIVE_BYTES) + 1),
        "content-type": "multipart/form-data; boundary=test",
      },
      body: "--test--",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "request_too_large" });
  });

  it("deletes a user-installed plugin", async () => {
    const host = { deletePlugin: async () => true } as unknown as AgentHost;
    const response = await pluginRoutes(host).request("/plugins/weather", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("404s deleting a plugin that is not user-installed", async () => {
    const host = { deletePlugin: async () => false } as unknown as AgentHost;
    const response = await pluginRoutes(host).request("/plugins/builtin", { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});
