#!/usr/bin/env node
/** One-time loopback OAuth consent; stores the client and refresh token in the OS keychain, or prints them with --print. */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { deliverRedirect, openBrowser, readClientFile, startConsent } from "./src/consent.mjs";
import { ENV_KEYS } from "./src/env-credentials.mjs";
import { SCOPES } from "./src/google.mjs";
import { deleteCredentials, loadCredentials, saveCredentials } from "./src/keychain.mjs";

const { values } = parseArgs({
  options: {
    "client-file": { type: "string" },
    "read-only": { type: "boolean", default: false },
    logout: { type: "boolean", default: false },
    print: { type: "boolean", default: false },
    "no-browser": { type: "boolean", default: false },
  },
});

if (values.logout) {
  console.log(deleteCredentials() ? "Removed Google credentials from the keychain." : "No stored credentials.");
  process.exit(0);
}

const { clientId, clientSecret } = readClient();
const scope = values["read-only"] ? SCOPES.readOnly : SCOPES.readWrite;
let refreshToken;
try {
  refreshToken = await consent();
} catch (err) {
  console.error(`Google sign-in failed: ${describe(err)}`);
  process.exit(1);
}
if (values.print) {
  // stdout carries only the env lines, so the output can be redirected into a Secret's env file.
  console.error(`Granted ${scope.length} scopes. Set these on the backend; they are secrets:\n`);
  console.log(`${ENV_KEYS.clientId}=${clientId}\n${ENV_KEYS.clientSecret}=${clientSecret}\n${ENV_KEYS.refreshToken}=${refreshToken}`);
} else {
  saveCredentials({ clientId, clientSecret, refreshToken });
  console.error(`Stored credentials in the OS keychain (${scope.length} scopes). Enable the google-workspace MCP server in Pizza Bot.`);
}

function readClient() {
  if (values["client-file"]) return readClientFile(values["client-file"]);
  const clientId = process.env[ENV_KEYS.clientId];
  const clientSecret = process.env[ENV_KEYS.clientSecret];
  if (clientId && clientSecret) return { clientId, clientSecret };
  // --print writes the client to stdout, so it never copies one out of the keychain unasked.
  const existing = values.print ? null : storedCredentials();
  if (existing) return { clientId: existing.clientId, clientSecret: existing.clientSecret };
  console.error(
    `Provide a Desktop-app OAuth client: --client-file <client_secret.json>, or set ${ENV_KEYS.clientId} and ${ENV_KEYS.clientSecret}.${values.print ? " --print does not read the keychain." : ""}`,
  );
  process.exit(1);
}

function storedCredentials() {
  try {
    return loadCredentials();
  } catch {
    return null;
  }
}

async function consent() {
  const { url, refreshToken: pending } = await startConsent({ clientId, clientSecret, scope });
  console.error(`Open this URL to grant access:\n\n${url}\n`);
  if (!values["no-browser"]) {
    openBrowser(url);
    return pending;
  }
  // Keeps an early rejection (timeout, denied state) from going unhandled while the prompt waits.
  pending.catch(() => {});
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new Promise((_, reject) => prompt.once("close", () => reject(new Error("No address was pasted."))));
  closed.catch(() => {});
  try {
    for (;;) {
      const pasted = await Promise.race([
        prompt.question("After approving, your browser fails to load a 127.0.0.1 page. Paste that page's full address here:\n"),
        closed,
      ]);
      try {
        await deliverRedirect(url, pasted);
        break;
      } catch (err) {
        console.error(describe(err));
      }
    }
  } finally {
    prompt.close();
  }
  return pending;
}

function describe(err) {
  const detail = err?.response?.data?.error_description;
  const message = err instanceof Error ? err.message : String(err);
  const text = detail ? `${message}: ${detail}` : message;
  return /invalid_client/.test(message)
    ? `${text} Check that the client ID and secret come from the same Desktop OAuth client; a new client can take a few minutes to start working.`
    : text;
}
