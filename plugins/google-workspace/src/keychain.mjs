/** OAuth client + refresh token in the OS keychain; one JSON blob so the pair cannot drift. */
import { Entry } from "@napi-rs/keyring";

const SERVICE = "pizza-bot-google-workspace";
const ACCOUNT = "oauth";

const entry = () => new Entry(SERVICE, ACCOUNT);

export function loadCredentials() {
  const raw = entry().getPassword();
  return raw ? JSON.parse(raw) : null;
}

export function saveCredentials(credentials) {
  entry().setPassword(JSON.stringify(credentials));
}

export function deleteCredentials() {
  return entry().deletePassword();
}
