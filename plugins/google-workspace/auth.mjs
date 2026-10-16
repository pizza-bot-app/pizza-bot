#!/usr/bin/env node
/** One-time loopback OAuth consent; stores the client and refresh token in the OS keychain. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { SCOPES, createOAuthClient } from "./src/google.mjs";
import { deleteCredentials, loadCredentials, saveCredentials } from "./src/keychain.mjs";

const TIMEOUT_MS = 5 * 60_000;

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
const refreshToken = await consent({ clientId, clientSecret, scope });
saveCredentials({ clientId, clientSecret, refreshToken });
console.log(`Stored credentials in the OS keychain (${scope.length} scopes). Reconnect the plugin in Pizza Bot.`);

function readClient() {
  if (values["client-file"]) {
    const parsed = JSON.parse(readFileSync(values["client-file"], "utf8"));
    const client = parsed.installed ?? parsed.web;
    if (client?.client_id && client?.client_secret) {
      return { clientId: client.client_id, clientSecret: client.client_secret };
    }
    throw new Error("--client-file must be the OAuth client JSON downloaded from Google Cloud Console.");
  }
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

async function consent({ clientId, clientSecret, scope }) {
  const state = randomBytes(16).toString("hex");
  const http = createServer();
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${http.address().port}`;
  const oauth = createOAuthClient({ clientId, clientSecret });
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope,
    state,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const code = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Google consent.")), TIMEOUT_MS);
    http.on("request", (req, res) => {
      const params = new URL(req.url, redirectUri).searchParams;
      if (!params.has("code") && !params.has("error")) {
        res.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      const ok = params.get("state") === state && params.has("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" });
      res.end(ok ? "Pizza Bot is connected. You can close this tab." : "Authorization failed. Return to the terminal.");
      if (ok) resolve(params.get("code"));
      else reject(new Error(params.get("error") ?? "OAuth state mismatch."));
    });
  }).finally(() => http.close());

  console.log(`Open this URL to grant access:\n\n${url}\n`);
  openBrowser(url);
  const { tokens } = await oauth.getToken({ code: await code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    throw new Error("Google returned no refresh token. Revoke the app at myaccount.google.com/permissions and retry.");
  }
  return tokens.refresh_token;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}
