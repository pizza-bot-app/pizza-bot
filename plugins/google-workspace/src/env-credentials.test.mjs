import assert from "node:assert/strict";
import { test } from "node:test";
import { envCredentials } from "./env-credentials.mjs";

const FULL = {
  GOOGLE_OAUTH_CLIENT_ID: "id",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
};

test("reads all three variables", () => {
  assert.deepEqual(envCredentials(FULL), { clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
});

test("treats a missing or forwarded-empty refresh token as unset", () => {
  assert.equal(envCredentials({}), undefined);
  assert.equal(envCredentials({ ...FULL, GOOGLE_OAUTH_REFRESH_TOKEN: "" }), undefined);
});

test("names the client variables a refresh token is missing", () => {
  assert.throws(
    () => envCredentials({ ...FULL, GOOGLE_OAUTH_CLIENT_SECRET: "" }),
    /GOOGLE_OAUTH_REFRESH_TOKEN is set but GOOGLE_OAUTH_CLIENT_SECRET is not\./,
  );
  assert.throws(
    () => envCredentials({ GOOGLE_OAUTH_REFRESH_TOKEN: "r" }),
    /GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not\./,
  );
});
