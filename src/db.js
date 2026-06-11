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

  -- One row per person the assistant talks to, linking their channels.
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT UNIQUE,              -- WhatsApp number (digits, intl format)
    email TEXT UNIQUE,
    name TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Calendar events recently modified BY the assistant (so the calendar
  -- watcher doesn't re-notify the owner about our own changes).
  CREATE TABLE IF NOT EXISTS touched_events (
    event_id TEXT PRIMARY KEY,
    touched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

// --- contacts ----------------------------------------------------------

export function upsertContactByWa(waId, name) {
  const existing = db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
  if (existing) {
    if (name && name !== existing.name) {
      db.prepare("UPDATE contacts SET name = ?, updated_at = ? WHERE wa_id = ?")
        .run(name, Date.now(), waId);
    }
    return { ...existing, name: name || existing.name };
  }
  db.prepare("INSERT INTO contacts (wa_id, name, updated_at) VALUES (?, ?, ?)")
    .run(waId, name || null, Date.now());
  return db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
}

export function upsertContactByEmail(email, name) {
  const normalized = email.toLowerCase();
  const existing = db.prepare("SELECT * FROM contacts WHERE email = ?").get(normalized);
  if (existing) {
    if (name && name !== existing.name) {
      db.prepare("UPDATE contacts SET name = ?, updated_at = ? WHERE email = ?")
        .run(name, Date.now(), normalized);
    }
    return { ...existing, name: name || existing.name };
  }
  db.prepare("INSERT INTO contacts (email, name, updated_at) VALUES (?, ?, ?)")
    .run(normalized, name || null, Date.now());
  return db.prepare("SELECT * FROM contacts WHERE email = ?").get(normalized);
}

/** Attach an email address to a WhatsApp contact (merges rows if both exist). */
export function linkContactEmail(waId, email) {
  const normalized = email.toLowerCase();
  const waRow = db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
  const emailRow = db.prepare("SELECT * FROM contacts WHERE email = ?").get(normalized);
  if (emailRow && waRow && emailRow.id !== waRow.id) {
    // Merge: keep the WhatsApp row, absorb the email row
    db.prepare("DELETE FROM contacts WHERE id = ?").run(emailRow.id);
    db.prepare("UPDATE contacts SET email = ?, name = COALESCE(name, ?), updated_at = ? WHERE id = ?")
      .run(normalized, emailRow.name, Date.now(), waRow.id);
  } else if (waRow) {
    db.prepare("UPDATE contacts SET email = ?, updated_at = ? WHERE id = ?")
      .run(normalized, Date.now(), waRow.id);
  } else if (emailRow) {
    db.prepare("UPDATE contacts SET wa_id = ?, updated_at = ? WHERE id = ?")
      .run(waId, Date.now(), emailRow.id);
  } else {
    db.prepare("INSERT INTO contacts (wa_id, email, updated_at) VALUES (?, ?, ?)")
      .run(waId, normalized, Date.now());
  }
  return db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
}

export function findContact({ waId, email }) {
  if (waId) {
    const row = db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
    if (row) return row;
  }
  if (email) {
    return db.prepare("SELECT * FROM contacts WHERE email = ?").get(email.toLowerCase()) || null;
  }
  return null;
}

// --- calendar watcher state ---------------------------------------------

export function markEventTouched(eventId) {
  db.prepare(
    "INSERT INTO touched_events (event_id, touched_at) VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET touched_at = excluded.touched_at"
  ).run(eventId, Date.now());
}

export function wasEventTouchedRecently(eventId, withinMs) {
  const row = db.prepare("SELECT touched_at FROM touched_events WHERE event_id = ?").get(eventId);
  return Boolean(row && Date.now() - row.touched_at < withinMs);
}

export function getState(key) {
  return db.prepare("SELECT value FROM kv_state WHERE key = ?").get(key)?.value ?? null;
}

export function setState(key, value) {
  db.prepare(
    "INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
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
