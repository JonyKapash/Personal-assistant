import express from "express";
import { config } from "./config.js";
import { parseWebhookMessages, sendWhatsappMessage } from "./services/whatsapp.js";
import { wasWhatsappProcessed, markWhatsappProcessed } from "./db.js";
import { runAgent, buildContext } from "./agent/agent.js";

export function createServer() {
  const app = express();
  app.use(express.json());

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

async function handleWhatsappMessage(msg) {
  if (wasWhatsappProcessed(msg.id)) return;
  markWhatsappProcessed(msg.id);

  if (msg.from !== config.owner.whatsapp) {
    console.warn(`[whatsapp] ignoring message from unauthorized number ${msg.from}`);
    return;
  }

  console.log(`[whatsapp] owner: ${msg.text.slice(0, 200)}`);
  const context = buildContext({ channel: "whatsapp-owner" });
  let reply;
  try {
    reply = await runAgent(`whatsapp:${msg.from}`, `${context}\n\n${msg.text}`);
  } catch (err) {
    console.error("[whatsapp] agent failed:", err);
    reply = "Sorry, something went wrong while handling that. Please try again.";
  }
  await sendWhatsappMessage(msg.from, reply);
}
