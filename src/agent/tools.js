import * as calendar from "../services/calendar.js";
import * as gmail from "../services/gmail.js";
import { notifyOwner } from "../services/whatsapp.js";

/**
 * Tool definitions (Anthropic JSON schema) + their implementations.
 * Descriptions state WHEN to call each tool, not just what it does.
 */
export const toolDefinitions = [
  {
    name: "get_events",
    description:
      "List calendar events in a date-time range. Call this whenever you need to know the schedule (e.g. \"what's on today\"), to locate an appointment someone wants to change, or before claiming anything about availability. Use the optional query to search by title or attendee.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Range start, ISO 8601 (e.g. 2026-06-10T00:00:00+03:00)" },
        time_max: { type: "string", description: "Range end, ISO 8601" },
        query: { type: "string", description: "Optional free-text search over event titles/descriptions/attendees" },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "find_free_slots",
    description:
      "Compute open time slots within working hours, checked against the real calendar. Call this before proposing meeting times to anyone - only offer slots this tool returns.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "First day to consider, YYYY-MM-DD" },
        to_date: { type: "string", description: "Last day to consider, YYYY-MM-DD" },
        duration_minutes: { type: "integer", description: "Appointment length in minutes (default from config)" },
      },
      required: ["from_date", "to_date"],
    },
  },
  {
    name: "create_event",
    description:
      "Create a new calendar appointment. Call when the owner asks to schedule something, or when an email participant has agreed on a specific time for a new meeting.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "Start, ISO 8601 with offset" },
        end: { type: "string", description: "End, ISO 8601 with offset" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses" },
        send_invites: { type: "boolean", description: "Send Google Calendar invitations to attendees (default false)" },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "update_event",
    description:
      "Modify an existing appointment (time, title, location...). Call when a new time has been agreed for an existing event. Get the event_id from get_events first.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        title: { type: "string" },
        start: { type: "string", description: "New start, ISO 8601 with offset" },
        end: { type: "string", description: "New end, ISO 8601 with offset" },
        description: { type: "string" },
        location: { type: "string" },
        send_invites: { type: "boolean", description: "Notify attendees of the change via Google Calendar (default false)" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_event",
    description:
      "Cancel an appointment. Only call when the owner explicitly asked to cancel, or a participant cancelled and the owner has been informed.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        send_invites: { type: "boolean", description: "Notify attendees of the cancellation (default false)" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "reply_to_email",
    description:
      "Reply to the email currently being handled (threads correctly in the recipient's inbox). This is the ONLY way an email sender receives your answer - your final text response does not reach them. Call it whenever an email deserves a reply (proposing times, confirming a change, etc.).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        body: { type: "string", description: "Plain-text email body" },
        reply_to_message_id: { type: "string", description: "Gmail message id of the email being replied to (provided in the email context)" },
        thread_id: { type: "string", description: "Gmail thread id (provided in the email context)" },
      },
      required: ["to", "body", "reply_to_message_id", "thread_id"],
    },
  },
  {
    name: "send_email",
    description:
      "Send a brand-new email (not a reply). Call when the owner asks you to email someone, e.g. to coordinate a new appointment with a participant.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "get_email_thread",
    description:
      "Fetch all messages in a Gmail thread. Call when you need earlier context of an email conversation (e.g. which times were proposed previously).",
    input_schema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "notify_owner",
    description:
      "Send a short WhatsApp message to the owner. Call after autonomous actions (rescheduled an appointment from an email, sent availability to someone) or to ask the owner a question you cannot answer yourself. Do NOT call when you are already talking to the owner on WhatsApp - just answer directly.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
];

const handlers = {
  get_events: (input) =>
    calendar.listEvents({ timeMin: input.time_min, timeMax: input.time_max, query: input.query }),
  find_free_slots: (input) =>
    calendar.findFreeSlots({
      fromDate: input.from_date,
      toDate: input.to_date,
      durationMinutes: input.duration_minutes,
    }),
  create_event: (input) =>
    calendar.createEvent({
      title: input.title,
      start: input.start,
      end: input.end,
      description: input.description,
      location: input.location,
      attendees: input.attendees,
      sendInvites: input.send_invites,
    }),
  update_event: (input) =>
    calendar.updateEvent({
      eventId: input.event_id,
      title: input.title,
      start: input.start,
      end: input.end,
      description: input.description,
      location: input.location,
      sendInvites: input.send_invites,
    }),
  delete_event: (input) =>
    calendar.deleteEvent({ eventId: input.event_id, sendInvites: input.send_invites }),
  reply_to_email: (input) =>
    gmail.sendEmail({
      to: input.to,
      body: input.body,
      replyToMessageId: input.reply_to_message_id,
      threadId: input.thread_id,
    }),
  send_email: (input) =>
    gmail.sendEmail({ to: input.to, subject: input.subject, body: input.body }),
  get_email_thread: (input) => gmail.getThreadMessages(input.thread_id),
  notify_owner: async (input) => {
    await notifyOwner(input.message);
    return { notified: true };
  },
};

export async function executeTool(name, input) {
  const handler = handlers[name];
  if (!handler) {
    return { isError: true, content: `Unknown tool: ${name}` };
  }
  try {
    const result = await handler(input);
    return { isError: false, content: JSON.stringify(result) };
  } catch (err) {
    console.error(`[tool:${name}] failed:`, err);
    return { isError: true, content: `Error: ${err.message}` };
  }
}
