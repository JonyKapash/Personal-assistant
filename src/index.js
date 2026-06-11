import { config } from "./config.js";
import { createServer } from "./server.js";
import { startEmailWatcher } from "./emailWatcher.js";
import { startCalendarWatcher } from "./calendarWatcher.js";
import { getAuth } from "./services/google.js";

async function main() {
  // Fail fast if Google auth hasn't been set up
  getAuth();

  const app = createServer();
  app.listen(config.server.port, () => {
    console.log(`[server] listening on port ${config.server.port}`);
    if (!config.whatsapp.enabled) {
      console.warn("[server] WhatsApp is not configured - webhook will accept but cannot send replies");
    }
  });

  startEmailWatcher();
  startCalendarWatcher();

  console.log(
    `Personal assistant running for ${config.owner.name} <${config.owner.email}> (model: ${config.anthropic.model}, tz: ${config.timezone})`
  );
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
