import { Hono } from "hono";
import {
  loadUserMcpServers,
  writeUserMcpServers,
} from "@pizza-bot/plugin-sdk";
import {
  mcpServerEntrySchema,
  type McpServerEntry,
} from "@pizza-bot/plugin-api";
import { CapabilityDependencyError, type AgentHost } from "./agent-host.js";
import { fileResourceRoutes, type ParseResult } from "./resource-crud.js";

// The user config file plus its parsed entry map, loaded once per request.
interface McpContainer {
  configFile: string;
  servers: Record<string, McpServerEntry>;
}

function parseEntry(raw: unknown): ParseResult<{ entry: McpServerEntry }> {
  const body = raw && typeof raw === "object" && "entry" in (raw as object) ? (raw as { entry: unknown }).entry : raw;
  const parsed = mcpServerEntrySchema.safeParse(body);
  if (!parsed.success) return { ok: false, detail: parsed.error.message };
  return { ok: true, entry: parsed.data };
}

export function mcpRoutes(host: AgentHost): Hono {
  const app = fileResourceRoutes<McpContainer, { entry: McpServerEntry }>({
    base: "/mcp-servers",
    disabledError: "mcp_disabled",
    container: async () => {
      const configFile = await host.mcpConfigFile();
      if (!configFile) return null;
      return { configFile, servers: await loadUserMcpServers(configFile) };
    },
    parse: parseEntry,
    exists: (container, id) => id in container.servers,
    reserved: async (_container, id) =>
      (await host.listMcpServers()).some((s) => s.id === id && s.source === "plugin"),
    writeConflict: async (container, id, parsed) => {
      if (
        parsed.entry.enabled !== false ||
        container.servers[id]?.enabled === false
      ) {
        return undefined;
      }
      const blockers = await host.mcpServerDisableBlockers(id);
      return blockers.length > 0
        ? {
            error: "resource_in_use",
            detail: "Enabled skills depend on this MCP server.",
            blockers,
          }
        : undefined;
    },
    removeConflict: async (_container, id) => {
      const blockers = await host.mcpServerDisableBlockers(id);
      return blockers.length > 0
        ? {
            error: "resource_in_use",
            detail: "Enabled skills depend on this MCP server.",
            blockers,
          }
        : undefined;
    },
    write: async (container, id, parsed) => {
      const sourceEnabled = container.servers[id]?.enabled;
      container.servers[id] =
        parsed.entry.enabled === undefined && sourceEnabled !== undefined
          ? { ...parsed.entry, enabled: sourceEnabled }
          : parsed.entry;
      await writeUserMcpServers(container.configFile, container.servers);
    },
    remove: async (container, id) => {
      delete container.servers[id];
      await writeUserMcpServers(container.configFile, container.servers);
      host.clearUserMcpServerPreference(id);
    },
    reload: () => host.reloadMcpServers(),
    present: async (id, parsed) =>
      (await host.listMcpServers()).find((s) => s.id === id && s.source === "user") ?? {
        id,
        source: "user",
        entry: parsed.entry,
      },
  });

  app.get("/mcp-servers", async (c) => {
    return c.json({ servers: await host.listMcpServers() });
  });

  app.put("/mcp-servers/:id/enabled", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "invalid", detail: "enabled must be a boolean" }, 400);
    }
    try {
      const server = await host.setMcpServerEnabled(c.req.param("id"), body.enabled);
      return server ? c.json(server) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof CapabilityDependencyError) {
        return c.json(
          { error: error.code, detail: error.message, blockers: error.blockers },
          409,
        );
      }
      throw error;
    }
  });

  app.post("/mcp-servers/:id/reconnect", async (c) => {
    const current = (await host.listMcpServers()).find(
      (server) => server.id === c.req.param("id"),
    );
    if (!current) return c.json({ error: "not_found" }, 404);
    if (!current.enabled) {
      return c.json(
        {
          error: "mcp_disabled",
          detail: "Enable this MCP server before reconnecting it.",
        },
        409,
      );
    }
    if (current.status !== "error" && current.status !== "crashed") {
      return c.json(
        {
          error: "mcp_not_reconnectable",
          detail: "Only failed or crashed MCP servers can be reconnected.",
        },
        409,
      );
    }
    const server = await host.reconnectMcpServer(current.id);
    return server ? c.json(server) : c.json({ error: "not_found" }, 404);
  });

  app.get("/mcp-servers/:id", async (c) => {
    const entry = await host.userMcpServer(c.req.param("id"));
    if (!entry) return c.json({ error: "not_found" }, 404);
    return c.json({ id: c.req.param("id"), source: "user" as const, entry });
  });

  return app;
}
