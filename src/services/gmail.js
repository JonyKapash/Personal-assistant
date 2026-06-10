import { getGmailClient } from "./google.js";
import { config } from "../config.js";

/** Fetch unread inbox messages (newest last) with parsed headers and body text. */
export async function fetchUnreadEmails() {
  const gmail = getGmailClient();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread in:inbox category:primary",
    maxResults: 10,
  });
  const ids = (list.data.messages || []).map((m) => m.id);
  const emails = [];
  for (const id of ids.reverse()) {
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    emails.push(parseMessage(full.data));
  }
  return emails;
}

export async function getThreadMessages(threadId) {
  const gmail = getGmailClient();
  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  return (thread.data.messages || []).map(parseMessage);
}

export async function markAsRead(messageId) {
  const gmail = getGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
}

/**
 * Send an email. When replyToMessageId is provided the message is threaded
 * as a reply (same subject thread in both Gmail and the recipient's client).
 */
export async function sendEmail({ to, subject, body, replyToMessageId, threadId }) {
  const gmail = getGmailClient();

  let headers = [
    `To: ${to}`,
    `From: ${config.owner.email}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ];

  let finalSubject = subject;
  if (replyToMessageId) {
    const original = await gmail.users.messages.get({
      userId: "me",
      id: replyToMessageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "Subject", "References"],
    });
    const get = (name) =>
      original.data.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    const origMsgId = get("Message-ID");
    const origSubject = get("Subject") || subject || "";
    finalSubject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    if (origMsgId) {
      headers.push(`In-Reply-To: ${origMsgId}`);
      const refs = get("References");
      headers.push(`References: ${refs ? `${refs} ${origMsgId}` : origMsgId}`);
    }
  }
  headers.push(`Subject: ${encodeHeader(finalSubject)}`);

  const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: threadId || undefined },
  });
  return { sent: true, messageId: res.data.id, threadId: res.data.threadId };
}

/** RFC 2047 encode non-ASCII subjects */
function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function parseMessage(message) {
  const headers = message.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  const fromRaw = get("From");
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  return {
    id: message.id,
    threadId: message.threadId,
    from: fromRaw,
    fromEmail: (emailMatch ? emailMatch[1] : fromRaw).trim().toLowerCase(),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
    body: extractBody(message.payload).slice(0, 8000),
  };
}

function extractBody(payload) {
  if (!payload) return "";
  if (payload.body?.data && (payload.mimeType === "text/plain" || !payload.parts)) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));
  }
  if (payload.body?.data) return stripHtml(decodeBase64Url(payload.body.data));
  return "";
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}
