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

const scope = values["read-only"] ? SCOPES.readOnly : SCOPES.readWrite;
const explicit = explicitClient();

// Separate paths keep a keychain-held secret from ever reaching stdout.
if (values.print) {
  const client = explicit ?? missingClient(" --print does not read the keychain.");
  const refreshToken = await signIn(client);
  // stdout carries only the env lines, so the output can be redirected into a Secret's env file.
  console.error(`Granted ${scope.length} scopes. Set these on the backend; they are secrets:\n`);
  console.log(`${ENV_KEYS.clientId}=${client.clientId}\n${ENV_KEYS.clientSecret}=${client.clientSecret}\n${ENV_KEYS.refreshToken}=${refreshToken}`);
} else {
  const client = explicit ?? storedClient() ?? missingClient("");
  const refreshToken = await signIn(client);
  saveCredentials({ ...client, refreshToken });
  console.error(`Stored credentials in the OS keychain (${scope.length} scopes). Enable the google-workspace MCP server in Pizza Bot.`);
}

function explicitClient() {
  if (values["client-file"]) return readClientFile(values["client-file"]);
  const clientId = process.env[ENV_KEYS.clientId];
  const clientSecret = process.env[ENV_KEYS.clientSecret];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function storedClient() {
  try {
    const stored = loadCredentials();
    return stored ? { clientId: stored.clientId, clientSecret: stored.clientSecret } : undefined;
  } catch {
    return undefined;
  }
}

function missingClient(note) {
  console.error(
    `Provide a Desktop-app OAuth client: --client-file <client_secret.json>, or set ${ENV_KEYS.clientId} and ${ENV_KEYS.clientSecret}.${note}`,
  );
  process.exit(1);
}

async function signIn(client) {
  try {
    return await consent(client);
  } catch (err) {
    console.error(`Google sign-in failed: ${describe(err)}`);
    process.exit(1);
  }
}

async function consent(client) {
  const { url, refreshToken: pending } = await startConsent({ ...client, scope });
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
