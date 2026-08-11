#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (
  process.env.MCP_REQUIRE_ELECTRON_RUN_AS_NODE === "1" &&
  process.env.ELECTRON_RUN_AS_NODE !== "1"
) {
  process.stderr.write("ELECTRON_RUN_AS_NODE was not propagated\n");
  process.exit(78);
}

const delayMs = Number(process.env.MCP_STARTUP_DELAY_MS ?? 0);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

const server = new McpServer({ name: "delayed", version: "1.0.0" });
server.registerTool(
  "get_mcp_status",
  {
    description: "Return pong.",
    inputSchema: { value: z.string().optional() },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: value ?? "pong" }],
  }),
);
await server.connect(new StdioServerTransport());
