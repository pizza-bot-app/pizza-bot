import { Hono } from "hono";
import type { AgentHost } from "./agent-host.js";
import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  PluginImportError,
  parsePluginArchive,
} from "./plugin-import.js";
import { limitMultipartBody } from "./request-limits.js";

export interface PluginsResponse {
  plugins: Array<{
    name: string;
    version?: string;
    displayName?: string;
    description?: string;
    author?: string;
    homepage?: string;
    // True only for plugins installed into the writable install dir (deletable through this API).
    removable: boolean;
    contributions: {
      skills: number;
      mcpServers: number;
    };
    materialization?: {
      state: "synced" | "stale" | "error";
      sourceRoots: string[];
      lastSyncedAt?: string;
      detail?: string;
    };
  }>;
}

export function pluginRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.post("/plugins/reload", async (c) => {
    await host.reloadPlugins("manual");
    return c.json({ reloaded: true });
  });

  app.post("/plugins/:name/refresh", async (c) => {
    const name = c.req.param("name");
    await host.reloadPlugins("manual");
    const materialization = host.plugins?.materializations[name];
    if (!materialization) return c.json({ error: "not_found" }, 404);
    return c.json({ name, materialization });
  });

  app.use("/plugins/import", limitMultipartBody(MAX_PLUGIN_ARCHIVE_BYTES));
  app.post("/plugins/import", async (c) => {
    if (!(await host.pluginsInstallDirectory())) {
      return c.json({ error: "plugins_disabled" }, 409);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "invalid_multipart", detail: "Expected a ZIP file upload." }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "missing_file", detail: "Select a ZIP file to import." }, 400);
    }
    if (file.size > MAX_PLUGIN_ARCHIVE_BYTES) {
      return c.json({ error: "archive_too_large", detail: "The selected ZIP file is too large." }, 413);
    }

    try {
      const plugin = await parsePluginArchive(new Uint8Array(await file.arrayBuffer()));
      if (await host.pluginIsInstalled(plugin.name)) {
        return c.json(
          { error: "already_exists", detail: `A plugin named "${plugin.name}" is already installed.` },
          409,
        );
      }
      await host.installPlugin(plugin);
      return c.json({ name: plugin.name }, 201);
    } catch (error) {
      if (error instanceof PluginImportError) {
        const status = error.code === "archive_too_large" ? 413 : 400;
        return c.json({ error: error.code, detail: error.message }, status);
      }
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return c.json({ error: "already_exists", detail: "A plugin with that name is already installed." }, 409);
      }
      throw error;
    }
  });

  app.delete("/plugins/:name", async (c) => {
    const removed = await host.deletePlugin(c.req.param("name"));
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted: true });
  });

  app.get("/plugins", async (c) => {
    await host.whenReady();
    const loaded = host.plugins;

    const resp: PluginsResponse = { plugins: [] };
    if (!loaded) return c.json(resp);

    resp.plugins = await Promise.all(
      loaded.manifests.map(async (m) => {
        const count = (entries: Iterable<{ pluginName: string }>) =>
          [...entries].filter((entry) => entry.pluginName === m.name).length;
        return {
          name: m.name,
          ...(m.version ? { version: m.version } : {}),
          ...(m.displayName ? { displayName: m.displayName } : {}),
          ...(m.description ? { description: m.description } : {}),
          ...(m.author?.name ? { author: m.author.name } : {}),
          ...(m.homepage ? { homepage: m.homepage } : {}),
          removable: await host.pluginIsInstalled(m.name),
          contributions: {
            skills: count(loaded.registry.skills.values()),
            mcpServers: count(loaded.registry.mcpServers.values()),
          },
          ...(loaded.materializations[m.name]
            ? { materialization: loaded.materializations[m.name] }
            : {}),
        };
      }),
    );

    return c.json(resp);
  });

  return app;
}
