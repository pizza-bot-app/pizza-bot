import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "browser-read", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["browser_evaluate", "browser_snapshot", "browser_take_screenshot", "export_text"].map((name) => ({
    name, description: "Read or export browser material.", inputSchema: {
      type: "object", properties: { filename: { type: "string" }, function: { type: "string" } },
      ...(name === "browser_evaluate" ? { required: ["filename", "function"] } : {}),
    },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }],
}));
await server.connect(new StdioServerTransport());
