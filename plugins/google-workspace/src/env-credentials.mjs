/** Credentials from the environment, for hosts without a keychain such as containers; `.mcp.json` forwards unset ones as "". */

export const ENV_KEYS = {
  clientId: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  refreshToken: "GOOGLE_OAUTH_REFRESH_TOKEN",
};

/** The refresh token opts in; without it the client variables only seed the `auth` CLI. */
export function envCredentials(env = process.env) {
  if (!env[ENV_KEYS.refreshToken]) return undefined;
  const missing = [ENV_KEYS.clientId, ENV_KEYS.clientSecret].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`${ENV_KEYS.refreshToken} is set but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not.`);
  }
  return {
    clientId: env[ENV_KEYS.clientId],
    clientSecret: env[ENV_KEYS.clientSecret],
    refreshToken: env[ENV_KEYS.refreshToken],
  };
}
