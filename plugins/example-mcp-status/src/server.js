#!/usr/bin/env node
/** Reference MCP stdio server; stdout is reserved for JSON-RPC. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function buildStatus(server) {
  const servers = [
    { name: "mcp-status", status: "connected", tools: 1, lastError: null },
    { name: "filesystem", status: "connected", tools: 6, lastError: null },
    { name: "weather", status: "degraded", tools: 2, lastError: "timeout after 5000ms" },
  ];
  const filtered = server ? servers.filter((s) => s.name === server) : servers;
  return {
    generatedAt: new Date().toISOString(),
    query: server ?? "*",
    servers: filtered,
    summary: {
      total: filtered.length,
      connected: filtered.filter((s) => s.status === "connected").length,
      degraded: filtered.filter((s) => s.status === "degraded").length,
      disconnected: filtered.filter((s) => s.status === "disconnected").length,
    },
  };
}

const server = new McpServer({ name: "mcp-status", version: "1.0.0" });

server.registerTool(
  "get_mcp_status",
  {
    description:
      "Return the current status of connected MCP servers (connectivity + tool counts). " +
      "Pass a server name to scope the report, or omit it for all servers.",
    inputSchema: {
      server: z
        .string()
        .optional()
        .describe("Optional server name to scope the status report to"),
    },
  },
  async ({ server: serverName }) => {
    const status = buildStatus(serverName);
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[mcp-status] stdio server ready\n");
