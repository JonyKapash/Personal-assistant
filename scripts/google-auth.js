/**
 * One-time Google OAuth flow.
 *
 * Usage: npm run auth:google
 * Opens an auth URL; after you approve access in the browser, the refresh
 * token is stored at GOOGLE_TOKEN_PATH for the assistant to use.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { createOAuthClient, GOOGLE_SCOPES } from "../src/services/google.js";

const client = createOAuthClient();

const authUrl = client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: GOOGLE_SCOPES,
});

console.log("\nOpen this URL in your browser and approve access:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:53682");
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing ?code parameter");
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    fs.mkdirSync(path.dirname(config.google.tokenPath), { recursive: true });
    fs.writeFileSync(config.google.tokenPath, JSON.stringify(tokens, null, 2));
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Authorized! You can close this tab and return to the terminal.");
    console.log(`Token saved to ${config.google.tokenPath}`);
  } catch (err) {
    res.writeHead(500).end("Token exchange failed: " + err.message);
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(53682, "127.0.0.1", () => {
  console.log("Waiting for the OAuth redirect on http://127.0.0.1:53682 ...");
});
