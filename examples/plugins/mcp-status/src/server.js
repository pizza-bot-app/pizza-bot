#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline";

const tools = [
  {
    name: "get_mcp_status",
    description: "Return deterministic MCP server status.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional server name to include in the response.",
        },
      },
    },
  },
];

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-status", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "ping") {
    respond(request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, { tools });
    return;
  }
  if (
    request.method === "tools/call" &&
    request.params?.name === "get_mcp_status"
  ) {
    const server = request.params.arguments?.server;
    respond(request.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            query: server ?? "*",
            servers: [
              { name: server ?? "mcp-status", status: "connected", tools: 1 },
            ],
          }),
        },
      ],
    });
    return;
  }
  respondError(request.id, -32601, `Method not found: ${request.method}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}
