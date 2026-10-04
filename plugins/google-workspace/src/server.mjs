#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClients } from "./google.mjs";
import { loadCredentials } from "./keychain.mjs";
import { createTools } from "./tools.mjs";

const AUTH_HINT = "Run `npm run auth -w @pizza-bot/plugin-google-workspace` to connect a Google account.";

let cached;
function clients() {
  if (cached) return cached;
  let credentials;
  try {
    credentials = loadCredentials();
  } catch (err) {
    throw new Error(`OS keychain is unavailable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!credentials) throw new Error(`No Google credentials in the OS keychain. ${AUTH_HINT}`);
  cached = createClients(credentials);
  return cached;
}

function describeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_grant/.test(message)) {
    return `Google rejected the stored refresh token (revoked or expired). ${AUTH_HINT}`;
  }
  if (/insufficient.*(scope|permission)/i.test(message)) {
    return `The granted Google scopes do not allow this action. Re-run auth without --read-only. (${message})`;
  }
  return message;
}

const server = new McpServer({ name: "google-workspace", version: "1.0.0" });

for (const tool of createTools(clients)) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    async (args) => {
      try {
        const result = await tool.handler(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
