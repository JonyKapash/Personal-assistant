import { config } from "./config.js";
import { fetchUnreadEmails, markAsRead } from "./services/gmail.js";
import { wasEmailProcessed, markEmailProcessed } from "./db.js";
import { runAgent, buildContext } from "./agent/agent.js";

let running = false;

/** Poll the Gmail inbox and hand new emails to the agent. */
export function startEmailWatcher() {
  const interval = config.google.pollSeconds * 1000;
  console.log(`[email] watching inbox every ${config.google.pollSeconds}s`);
  setInterval(tick, interval);
  tick();
}

async function tick() {
  if (running) return; // don't overlap slow runs
  running = true;
  try {
    const emails = await fetchUnreadEmails();
    for (const email of emails) {
      if (wasEmailProcessed(email.id)) continue;
      if (email.fromEmail === config.owner.email) {
        // Don't react to the owner's own sent mail landing in inbox
        markEmailProcessed(email.id);
        continue;
      }
      console.log(`[email] processing "${email.subject}" from ${email.fromEmail}`);
      try {
        await handleEmail(email);
        markEmailProcessed(email.id);
        await markAsRead(email.id);
      } catch (err) {
        console.error(`[email] failed to process ${email.id}:`, err);
        // Not marked processed -> retried on the next poll
      }
    }
  } catch (err) {
    console.error("[email] poll failed:", err.message);
  } finally {
    running = false;
  }
}

async function handleEmail(email) {
  const context = buildContext({
    channel: "email",
    extra: [
      `email from: ${email.from}`,
      `email subject: ${email.subject}`,
      `gmail message id: ${email.id}`,
      `gmail thread id: ${email.threadId}`,
    ],
  });
  const prompt = `${context}\n\nNew incoming email:\n\n${email.body}`;
  const result = await runAgent(`email:${email.threadId}`, prompt);
  if (result.trim() !== "SKIP") {
    console.log(`[email] agent result: ${result.slice(0, 200)}`);
  }
}
