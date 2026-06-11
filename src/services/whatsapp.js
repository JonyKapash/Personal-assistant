import { config } from "../config.js";

const GRAPH_URL = () =>
  `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

/** Send a WhatsApp text message via the Business Cloud API. */
export async function sendWhatsappMessage(to, text) {
  if (!config.whatsapp.enabled) {
    console.warn("[whatsapp] not configured; message not sent:", text.slice(0, 120));
    return { sent: false, reason: "whatsapp not configured" };
  }
  // WhatsApp caps text messages at 4096 chars
  const chunks = splitText(text, 4000);
  let lastId = null;
  for (const chunk of chunks) {
    const res = await fetch(GRAPH_URL(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`WhatsApp send failed (${res.status}): ${JSON.stringify(data)}`);
    }
    lastId = data.messages?.[0]?.id || null;
  }
  return { sent: true, messageId: lastId };
}

/** Notify the owner on WhatsApp; never throws (used for fire-and-forget updates). */
export async function notifyOwner(text) {
  if (!config.owner.whatsapp) return;
  try {
    await sendWhatsappMessage(config.owner.whatsapp, text);
  } catch (err) {
    console.error("[whatsapp] failed to notify owner:", err.message);
  }
}

/** Extract incoming text messages (with sender profile names) from a webhook payload. */
export function parseWebhookMessages(body) {
  const messages = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const profiles = new Map(
        (value.contacts || []).map((c) => [c.wa_id, c.profile?.name || null])
      );
      for (const msg of value.messages || []) {
        if (msg.type !== "text") continue;
        messages.push({
          id: msg.id,
          from: msg.from, // sender wa_id (international number, digits only)
          name: profiles.get(msg.from) || null,
          text: msg.text?.body || "",
          timestamp: Number(msg.timestamp) * 1000,
        });
      }
    }
  }
  return messages;
}

function splitText(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
