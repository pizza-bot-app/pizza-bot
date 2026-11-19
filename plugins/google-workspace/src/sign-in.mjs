/** In-app sign-in: a tool call without stored credentials opens the browser consent instead of failing. */
import { ENV_KEYS } from "./env-credentials.mjs";

const SETUP_GUIDE = "https://github.com/pizza-bot-app/pizza-bot/blob/main/docs/GOOGLE_WORKSPACE.md";

export function createSignIn({
  clientDir,
  envCredentials = () => undefined,
  scope,
  loadCredentials,
  saveCredentials,
  findClientFile,
  removeFile,
  startConsent,
  openBrowser,
}) {
  let pending;
  let failure;

  function prompt(client, clientFile) {
    if (!pending) {
      const flow = startConsent({ ...client, scope }).then(({ url, refreshToken }) => {
        openBrowser(url);
        refreshToken
          .then((token) => {
            saveCredentials({ ...client, refreshToken: token });
            if (clientFile) removeFile(clientFile);
          })
          .catch((err) => {
            failure = err instanceof Error ? err.message : String(err);
          })
          .finally(() => {
            if (pending === flow) pending = undefined;
          });
        return url;
      });
      flow.catch(() => {
        if (pending === flow) pending = undefined;
      });
      pending = flow;
    }
    return pending.then(
      (url) =>
        `Finish signing in to Google in the browser tab Pizza Bot opened, then ask again. If no tab opened, visit: ${url}`,
    );
  }

  function takeFailure() {
    const message = failure ? `The last Google sign-in failed: ${failure} ` : "";
    failure = undefined;
    return message;
  }

  return {
    async credentials() {
      const fromEnv = envCredentials();
      if (fromEnv) return fromEnv;
      let stored;
      try {
        stored = loadCredentials();
      } catch (err) {
        throw new Error(
          `OS keychain is unavailable: ${err instanceof Error ? err.message : String(err)}. On a headless or container backend, set ${ENV_KEYS.clientId}, ${ENV_KEYS.clientSecret}, and ${ENV_KEYS.refreshToken} instead; see ${SETUP_GUIDE}.`,
          { cause: err },
        );
      }
      if (stored) return stored;
      const previous = takeFailure();
      const found = findClientFile(clientDir);
      if (!found) {
        throw new Error(
          `${previous}No Google account is connected. Create a Desktop OAuth client by following ${SETUP_GUIDE}, save its JSON in ${clientDir}, then ask again.`,
        );
      }
      throw new Error(previous + (await prompt(found.client, found.path)));
    },

    /** Re-consents with the stored client after Google revokes or expires the refresh token. */
    async reauthorize({ clientId, clientSecret }) {
      if (envCredentials()) {
        return `Replace ${ENV_KEYS.refreshToken} with a fresh token from \`npm run auth -w @pizza-bot/plugin-google-workspace -- --print\`, then restart the backend.`;
      }
      return takeFailure() + (await prompt({ clientId, clientSecret }));
    },
  };
}
