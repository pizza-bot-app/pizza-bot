import { calendar } from "@googleapis/calendar";
import { gmail } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";

export const SCOPES = {
  readOnly: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
  ],
  readWrite: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
};

export function createOAuthClient({ clientId, clientSecret }) {
  return new OAuth2Client({ clientId, clientSecret });
}

export function createClients({ clientId, clientSecret, refreshToken }) {
  const auth = createOAuthClient({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: refreshToken });
  return {
    gmail: gmail({ version: "v1", auth }),
    calendar: calendar({ version: "v3", auth }),
  };
}
