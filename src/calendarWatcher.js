import { config } from "./config.js";
import { listUpdatedEvents } from "./services/calendar.js";
import { getState, setState, wasEventTouchedRecently } from "./db.js";
import { notifyOwner } from "./services/whatsapp.js";

/**
 * Watches the Google Calendar for changes the assistant did NOT make
 * (events added/moved/cancelled from another device, accepted invites, etc.)
 * and notifies the owner on WhatsApp. Changes made by the assistant itself
 * are excluded via the touched_events table.
 */
export function startCalendarWatcher() {
  const interval = config.google.calendarWatchSeconds * 1000;
  console.log(`[calendar] watching for external changes every ${config.google.calendarWatchSeconds}s`);
  setInterval(tick, interval);
}

// Ignore our own changes for 10 minutes after we make them (Google's
// "updated" timestamp can lag the API call slightly).
const TOUCH_GRACE_MS = 10 * 60 * 1000;

async function tick() {
  const since = getState("calendar_last_check");
  const now = new Date().toISOString();
  setState("calendar_last_check", now);
  if (!since) return; // first run: establish the baseline only

  try {
    const updated = await listUpdatedEvents(since);
    const external = updated.filter((e) => !wasEventTouchedRecently(e.id, TOUCH_GRACE_MS));
    if (external.length === 0) return;

    const lines = external.slice(0, 10).map((e) => {
      const when = e.start
        ? new Intl.DateTimeFormat("en-GB", {
            timeZone: config.timezone,
            weekday: "short", day: "numeric", month: "short",
            hour: "2-digit", minute: "2-digit",
          }).format(new Date(e.start))
        : "?";
      return e.cancelled ? `- Cancelled: "${e.title}" (${when})` : `- "${e.title}" - ${when}`;
    });
    await notifyOwner(`Calendar update:\n${lines.join("\n")}`);
  } catch (err) {
    console.error("[calendar] watch failed:", err.message);
  }
}
