import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,            -- "email:<threadId>" or "whatsapp:<wa_id>"
    messages TEXT NOT NULL,         -- JSON array of Anthropic MessageParam
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_emails (
    message_id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_whatsapp (
    message_id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
  );
`);

// Keep history bounded so a long-lived thread doesn't grow without limit.
// History is trimmed at a user-message boundary so tool_use/tool_result
// pairs are never split apart.
const MAX_HISTORY_MESSAGES = 40;

export function getConversation(id) {
  const row = db.prepare("SELECT messages FROM conversations WHERE id = ?").get(id);
  return row ? JSON.parse(row.messages) : [];
}

export function saveConversation(id, messages) {
  let trimmed = messages;
  if (messages.length > MAX_HISTORY_MESSAGES) {
    let start = messages.length - MAX_HISTORY_MESSAGES;
    while (start < messages.length && !isPlainUserMessage(messages[start])) start++;
    trimmed = messages.slice(start);
  }
  db.prepare(
    `INSERT INTO conversations (id, messages, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`
  ).run(id, JSON.stringify(trimmed), Date.now());
}

function isPlainUserMessage(message) {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return !message.content.some((block) => block.type === "tool_result");
}

export function wasEmailProcessed(messageId) {
  return Boolean(db.prepare("SELECT 1 FROM processed_emails WHERE message_id = ?").get(messageId));
}

export function markEmailProcessed(messageId) {
  db.prepare(
    "INSERT OR IGNORE INTO processed_emails (message_id, processed_at) VALUES (?, ?)"
  ).run(messageId, Date.now());
}

export function wasWhatsappProcessed(messageId) {
  return Boolean(
    db.prepare("SELECT 1 FROM processed_whatsapp WHERE message_id = ?").get(messageId)
  );
}

export function markWhatsappProcessed(messageId) {
  db.prepare(
    "INSERT OR IGNORE INTO processed_whatsapp (message_id, processed_at) VALUES (?, ?)"
  ).run(messageId, Date.now());
}

export default db;
