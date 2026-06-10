import { getCalendarClient } from "./google.js";
import { config } from "../config.js";

const calendarId = () => config.google.calendarId;

function toEventSummary(event) {
  return {
    id: event.id,
    title: event.summary || "(no title)",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    allDay: Boolean(event.start?.date),
    location: event.location || null,
    description: event.description || null,
    attendees: (event.attendees || []).map((a) => ({
      email: a.email,
      name: a.displayName || null,
      response: a.responseStatus,
    })),
    status: event.status,
    htmlLink: event.htmlLink,
  };
}

export async function listEvents({ timeMin, timeMax, query }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.list({
    calendarId: calendarId(),
    timeMin,
    timeMax,
    q: query || undefined,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items || []).map(toEventSummary);
}

export async function createEvent({ title, start, end, description, location, attendees, sendInvites }) {
  const calendar = getCalendarClient();
  const res = await calendar.events.insert({
    calendarId: calendarId(),
    sendUpdates: sendInvites ? "all" : "none",
    requestBody: {
      summary: title,
      description: description || undefined,
      location: location || undefined,
      start: { dateTime: start, timeZone: config.timezone },
      end: { dateTime: end, timeZone: config.timezone },
      attendees: (attendees || []).map((email) => ({ email })),
    },
  });
  return toEventSummary(res.data);
}

export async function updateEvent({ eventId, title, start, end, description, location, sendInvites }) {
  const calendar = getCalendarClient();
  const patch = {};
  if (title) patch.summary = title;
  if (description) patch.description = description;
  if (location) patch.location = location;
  if (start) patch.start = { dateTime: start, timeZone: config.timezone };
  if (end) patch.end = { dateTime: end, timeZone: config.timezone };
  const res = await calendar.events.patch({
    calendarId: calendarId(),
    eventId,
    sendUpdates: sendInvites ? "all" : "none",
    requestBody: patch,
  });
  return toEventSummary(res.data);
}

export async function deleteEvent({ eventId, sendInvites }) {
  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: calendarId(),
    eventId,
    sendUpdates: sendInvites ? "all" : "none",
  });
  return { deleted: true, eventId };
}

/**
 * Compute free slots between fromDate and toDate (inclusive, YYYY-MM-DD)
 * within configured working hours, using the Calendar free/busy API.
 */
export async function findFreeSlots({ fromDate, toDate, durationMinutes }) {
  const calendar = getCalendarClient();
  const duration = (durationMinutes || config.scheduling.defaultMinutes) * 60 * 1000;

  const timeMin = zonedDateTime(fromDate, "00:00");
  const timeMax = zonedDateTime(toDate, "23:59");

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: config.timezone,
      items: [{ id: calendarId() }],
    },
  });
  const busy = (fb.data.calendars?.[calendarId()]?.busy || []).map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const now = Date.now();
  const slots = [];
  for (let day = new Date(timeMin); day <= timeMax; day.setDate(day.getDate() + 1)) {
    const dateStr = formatDateInZone(day);
    const windowStart = zonedDateTime(dateStr, config.scheduling.workDayStart).getTime();
    const windowEnd = zonedDateTime(dateStr, config.scheduling.workDayEnd).getTime();

    let cursor = Math.max(windowStart, now);
    // Round up to the next half hour
    cursor = Math.ceil(cursor / (30 * 60 * 1000)) * 30 * 60 * 1000;

    while (cursor + duration <= windowEnd) {
      const overlap = busy.find((b) => cursor < b.end && cursor + duration > b.start);
      if (overlap) {
        cursor = Math.ceil(overlap.end / (30 * 60 * 1000)) * 30 * 60 * 1000;
      } else {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + duration).toISOString(),
          local: formatSlotInZone(cursor, cursor + duration),
        });
        cursor += duration;
      }
      if (slots.length >= 20) return slots;
    }
  }
  return slots;
}

/** Build a Date for a wall-clock time in the configured timezone. */
function zonedDateTime(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  // Find the UTC offset of the configured zone at this date
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const offsetMinutes = zoneOffsetMinutes(probe);
  const utc = Date.UTC(
    ...dateStr.split("-").map(Number).map((v, i) => (i === 1 ? v - 1 : v)),
    h,
    m
  );
  return new Date(utc - offsetMinutes * 60 * 1000);
}

function zoneOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function formatDateInZone(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function formatSlotInZone(startMs, endMs) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit", minute: "2-digit",
  });
  return `${fmt.format(new Date(startMs))} - ${timeFmt.format(new Date(endMs))} (${config.timezone})`;
}
