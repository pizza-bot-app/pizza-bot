/** Loopback PKCE consent shared by the `auth` CLI and the server's in-app sign-in. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createOAuthClient } from "./google.mjs";

const TIMEOUT_MS = 5 * 60_000;

export function readClientFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const client = parsed.installed ?? parsed.web;
  if (client?.client_id && client?.client_secret) {
    return { clientId: client.client_id, clientSecret: client.client_secret };
  }
  throw new Error(`${path} is not an OAuth client JSON downloaded from Google Cloud Console.`);
}

/** First valid client JSON in `dir`, creating `dir` so the user has somewhere to put one. */
export function findClientFile(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, name);
    try {
      return { path, client: readClientFile(path) };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Starts the loopback listener and resolves once the consent URL is ready; `refreshToken` settles when the browser returns. */
export async function startConsent({ clientId, clientSecret, scope, timeoutMs = TIMEOUT_MS }) {
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
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Google consent.")), timeoutMs);
    http.on("request", (req, res) => {
      const params = new URL(req.url, redirectUri).searchParams;
      if (!params.has("code") && !params.has("error")) {
        res.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      const ok = params.get("state") === state && params.has("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" });
      res.end(ok ? "Pizza Bot is connected. You can close this tab." : "Authorization failed. Close this tab and try again.");
      if (ok) resolve(params.get("code"));
      else reject(new Error(params.get("error") ?? "OAuth state mismatch."));
    });
  }).finally(() => http.close());

  const refreshToken = code.then(async (value) => {
    const { tokens } = await oauth.getToken({ code: value, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error("Google returned no refresh token. Revoke the app at myaccount.google.com/permissions and retry.");
    }
    return tokens.refresh_token;
  });
  return { url, refreshToken };
}

export function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}
