#!/usr/bin/env node
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findClientFile, openBrowser, startConsent } from "./consent.mjs";
import { SCOPES, createClients } from "./google.mjs";
import { loadCredentials, saveCredentials } from "./keychain.mjs";
import { createSignIn } from "./sign-in.mjs";
import { createTools } from "./tools.mjs";

// The manifest forwards these for the Linux keychain (D-Bus); an unset one arrives as "", which D-Bus rejects.
for (const key of ["PIZZA_DATA_ROOT", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) {
  if (process.env[key] === "") delete process.env[key];
}

const dataRoot = process.env.PIZZA_DATA_ROOT ?? join(homedir(), ".pizza-bot-oss");

const signIn = createSignIn({
  clientDir: join(dataRoot, "google-workspace"),
  scope: SCOPES.readWrite,
  loadCredentials,
  saveCredentials,
  findClientFile,
  removeFile: (path) => rmSync(path, { force: true }),
  startConsent,
  openBrowser,
});

let session;
const clients = () => session.clients;

function describeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient.*(scope|permission)/i.test(message)) {
    return `The granted Google scopes do not allow this action. Remove Pizza Bot at https://myaccount.google.com/permissions, then ask again to sign in with every scope. (${message})`;
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
        if (!session) {
          const credentials = await signIn.credentials();
          session = { credentials, clients: createClients(credentials) };
        }
        const result = await tool.handler(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (session && /invalid_grant/.test(err instanceof Error ? err.message : String(err))) {
          const { credentials } = session;
          session = undefined;
          const next = await signIn.reauthorize(credentials).catch((e) => (e instanceof Error ? e.message : String(e)));
          return { isError: true, content: [{ type: "text", text: `Google rejected the stored sign-in (revoked or expired). ${next}` }] };
        }
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
