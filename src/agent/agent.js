import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { toolsForChannel, executeTool } from "./tools.js";
import { getConversation, saveConversation } from "../db.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const MAX_ITERATIONS = 15;

/**
 * Run the assistant on one incoming message.
 *
 * @param {string} conversationId - stable id, e.g. "whatsapp:9725..." or "email:<threadId>"
 * @param {string} userText - the incoming message, wrapped with channel context
 * @param {object} ctx - { channel, contact: {wa_id, email, name} | null }
 * @returns {string} the assistant's final text response
 */
export async function runAgent(conversationId, userText, ctx = { channel: "whatsapp-owner", contact: null }) {
  const messages = getConversation(conversationId);
  messages.push({ role: "user", content: userText });
  const tools = toolsForChannel(ctx.channel);

  let response;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools,
      messages,
    });

    // Append the full assistant content (text + thinking + tool_use blocks);
    // thinking blocks must be passed back unchanged on subsequent calls.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      messages.pop();
      saveConversation(conversationId, messages);
      return "Sorry, I can't help with that request.";
    }

    if (response.stop_reason !== "tool_use") break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`[agent] tool: ${block.name}`, JSON.stringify(block.input).slice(0, 300));
      const result = await executeTool(block.name, block.input, ctx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError || undefined,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  saveConversation(conversationId, messages);

  const text = (response?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "(done)";
}

/** Context block prepended to every incoming message so the model knows the channel, sender, and current time. */
export function buildContext({ channel, contact, extra }) {
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date());
  const lines = [
    `channel: ${channel}`,
    `current datetime: ${now} (${config.timezone})`,
  ];
  if (contact) {
    lines.push(`sender: ${contact.name || "unknown name"} (whatsapp: ${contact.wa_id || "-"}, email: ${contact.email || "-"})`);
  }
  if (extra) lines.push(...extra);
  return `<context>\n${lines.join("\n")}\n</context>`;
}
