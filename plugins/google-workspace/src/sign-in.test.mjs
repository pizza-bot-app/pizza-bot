import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findClientFile } from "./consent.mjs";
import { createSignIn } from "./sign-in.mjs";

const CLIENT = { clientId: "id", clientSecret: "secret" };

function harness({ stored = null, clientFile = { path: "/c/client.json", client: CLIENT } } = {}) {
  const calls = { consents: [], opened: [], saved: [], removed: [] };
  let finish;
  const signIn = createSignIn({
    clientDir: "/c",
    scope: ["s"],
    loadCredentials: () => stored,
    saveCredentials: (c) => {
      calls.saved.push(c);
      stored = c;
    },
    findClientFile: () => clientFile ?? undefined,
    removeFile: (p) => calls.removed.push(p),
    startConsent: async (args) => {
      calls.consents.push(args);
      const refreshToken = new Promise((resolve, reject) => (finish = { resolve, reject }));
      return { url: `https://consent/${calls.consents.length}`, refreshToken };
    },
    openBrowser: (url) => calls.opened.push(url),
  });
  return { signIn, calls, finish: () => finish };
}

const settle = () => new Promise((r) => setImmediate(r));

test("returns stored credentials without starting a sign-in", async () => {
  const stored = { ...CLIENT, refreshToken: "r" };
  const { signIn, calls } = harness({ stored });
  assert.deepEqual(await signIn.credentials(), stored);
  assert.equal(calls.consents.length, 0);
});

test("names the client folder when no client JSON is present", async () => {
  const { signIn, calls } = harness({ clientFile: null });
  await assert.rejects(signIn.credentials(), /Create a Desktop OAuth client by following https:\/\/github\.com\/.*GOOGLE_WORKSPACE\.md, save its JSON in \/c,/);
  assert.equal(calls.consents.length, 0);
});

test("opens one browser consent, stores the token, and removes the client file", async () => {
  const { signIn, calls, finish } = harness();
  await assert.rejects(signIn.credentials(), /browser tab .* visit: https:\/\/consent\/1/);
  await assert.rejects(signIn.credentials(), /visit: https:\/\/consent\/1/);
  assert.equal(calls.consents.length, 1);
  assert.deepEqual(calls.opened, ["https://consent/1"]);
  assert.deepEqual(calls.consents[0], { ...CLIENT, scope: ["s"] });

  finish().resolve("refresh");
  await settle();
  assert.deepEqual(calls.saved, [{ ...CLIENT, refreshToken: "refresh" }]);
  assert.deepEqual(calls.removed, ["/c/client.json"]);
  assert.deepEqual(await signIn.credentials(), { ...CLIENT, refreshToken: "refresh" });
});

test("reports a failed consent once and starts a fresh one", async () => {
  const { signIn, calls, finish } = harness();
  await assert.rejects(signIn.credentials());
  finish().reject(new Error("access_denied"));
  await settle();
  await assert.rejects(signIn.credentials(), /last Google sign-in failed: access_denied .*consent\/2/);
  assert.equal(calls.consents.length, 2);
  assert.deepEqual(calls.removed, []);
});

test("wraps keychain failures", async () => {
  const signIn = createSignIn({
    clientDir: "/c",
    loadCredentials: () => {
      throw new Error("no secret service");
    },
  });
  await assert.rejects(signIn.credentials(), /OS keychain is unavailable: no secret service/);
});

test("reauthorize reuses the stored client without a client file", async () => {
  const { signIn, calls } = harness({ clientFile: null });
  assert.match(await signIn.reauthorize({ ...CLIENT, refreshToken: "old" }), /consent\/1/);
  assert.deepEqual(calls.consents[0], { ...CLIENT, scope: ["s"] });
});

test("findClientFile creates the folder and skips files that are not OAuth clients", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "gw-")), "google-workspace");
  try {
    assert.equal(findClientFile(dir), undefined);
    writeFileSync(join(dir, "a-notes.json"), JSON.stringify({ hello: 1 }));
    writeFileSync(join(dir, "b-client.json"), JSON.stringify({ installed: { client_id: "i", client_secret: "s" } }));
    assert.deepEqual(findClientFile(dir), {
      path: join(dir, "b-client.json"),
      client: { clientId: "i", clientSecret: "s" },
    });
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("startConsent's loopback listener rejects a mismatched state", async () => {
  const { startConsent } = await import("./consent.mjs");
  const { url, refreshToken } = await startConsent({ ...CLIENT, scope: ["s"], timeoutMs: 5_000 });
  const redirect = new URL(new URL(url).searchParams.get("redirect_uri"));
  assert.equal(redirect.hostname, "127.0.0.1");
  const rejected = assert.rejects(refreshToken, /OAuth state mismatch/);
  const res = await fetch(`${redirect.origin}/?code=c&state=wrong`);
  assert.equal(res.status, 400);
  await rejected;
});
