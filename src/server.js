import express from "express";
import crypto from "node:crypto";
import { config } from "./config.js";
import { parseWebhookMessages, sendWhatsappMessage } from "./services/whatsapp.js";
import { wasWhatsappProcessed, markWhatsappProcessed, upsertContactByWa } from "./db.js";
import { runAgent, buildContext } from "./agent/agent.js";

export function createServer() {
  const app = express();
  // Keep the raw body so the Meta webhook signature can be verified
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Meta webhook verification handshake
  app.get("/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
      console.log("[whatsapp] webhook verified");
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Incoming WhatsApp messages
  app.post("/webhooks/whatsapp", (req, res) => {
    if (!verifySignature(req)) {
      console.warn("[whatsapp] webhook signature verification failed");
      return res.sendStatus(403);
    }
    // Ack immediately; Meta retries on slow responses
    res.sendStatus(200);
    const messages = parseWebhookMessages(req.body);
    for (const msg of messages) {
      handleWhatsappMessage(msg).catch((err) =>
        console.error("[whatsapp] message handling failed:", err)
      );
    }
  });

  return app;
}

/** Verify X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
function verifySignature(req) {
  if (!config.whatsapp.appSecret) return true; // not configured (dev mode)
  const header = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.whatsapp.appSecret).update(req.rawBody).digest("hex");
  return (
    header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))
  );
}

async function handleWhatsappMessage(msg) {
  if (wasWhatsappProcessed(msg.id)) return;
  markWhatsappProcessed(msg.id);

  const isOwner = msg.from === config.owner.whatsapp;
  const channel = isOwner ? "whatsapp-owner" : "whatsapp-client";
  const contact = isOwner
    ? { wa_id: msg.from, email: config.owner.email, name: config.owner.name }
    : upsertContactByWa(msg.from, msg.name);

  console.log(`[whatsapp] ${channel} ${msg.from}: ${msg.text.slice(0, 200)}`);

  const context = buildContext({ channel, contact });
  let reply;
  try {
    reply = await runAgent(`whatsapp:${msg.from}`, `${context}\n\n${msg.text}`, {
      channel,
      contact,
    });
  } catch (err) {
    console.error("[whatsapp] agent failed:", err);
    reply = "Sorry, something went wrong while handling that. Please try again.";
  }
  await sendWhatsappMessage(msg.from, reply);
}
