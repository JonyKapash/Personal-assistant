import fs from "node:fs";
import { google } from "googleapis";
import { config } from "../config.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function createOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    // Loopback redirect used by the one-time auth script
    "http://127.0.0.1:53682/oauth2callback"
  );
}

let cachedAuth = null;

/** Returns an authorized OAuth2 client, loading the stored refresh token. */
export function getAuth() {
  if (cachedAuth) return cachedAuth;
  if (!fs.existsSync(config.google.tokenPath)) {
    throw new Error(
      `Google token not found at ${config.google.tokenPath}. Run "npm run auth:google" first.`
    );
  }
  const auth = createOAuthClient();
  auth.setCredentials(JSON.parse(fs.readFileSync(config.google.tokenPath, "utf8")));
  auth.on("tokens", (tokens) => {
    // Persist refreshed tokens so restarts don't require re-auth
    const current = JSON.parse(fs.readFileSync(config.google.tokenPath, "utf8"));
    fs.writeFileSync(config.google.tokenPath, JSON.stringify({ ...current, ...tokens }, null, 2));
  });
  cachedAuth = auth;
  return auth;
}

export function getCalendarClient() {
  return google.calendar({ version: "v3", auth: getAuth() });
}

export function getGmailClient() {
  return google.gmail({ version: "v1", auth: getAuth() });
}
