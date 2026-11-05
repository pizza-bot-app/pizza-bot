#!/usr/bin/env node
/** One-time loopback OAuth consent; stores the client and refresh token in the OS keychain. */
import { parseArgs } from "node:util";
import { openBrowser, readClientFile, startConsent } from "./src/consent.mjs";
import { SCOPES } from "./src/google.mjs";
import { deleteCredentials, loadCredentials, saveCredentials } from "./src/keychain.mjs";

const { values } = parseArgs({
  options: {
    "client-file": { type: "string" },
    "read-only": { type: "boolean", default: false },
    logout: { type: "boolean", default: false },
  },
});

if (values.logout) {
  console.log(deleteCredentials() ? "Removed Google credentials from the keychain." : "No stored credentials.");
  process.exit(0);
}

const { clientId, clientSecret } = readClient();
const scope = values["read-only"] ? SCOPES.readOnly : SCOPES.readWrite;
const { url, refreshToken: pendingToken } = await startConsent({ clientId, clientSecret, scope });
console.log(`Open this URL to grant access:\n\n${url}\n`);
openBrowser(url);
const refreshToken = await pendingToken;
saveCredentials({ clientId, clientSecret, refreshToken });
console.log(`Stored credentials in the OS keychain (${scope.length} scopes). Enable the google-workspace MCP server in Pizza Bot.`);

function readClient() {
  if (values["client-file"]) return readClientFile(values["client-file"]);
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  const existing = loadCredentials();
  if (existing) return { clientId: existing.clientId, clientSecret: existing.clientSecret };
  console.error(
    "Provide a Desktop-app OAuth client: --client-file <client_secret.json>, or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
  );
  process.exit(1);
}
