import * as calendar from "../services/calendar.js";
import * as gmail from "../services/gmail.js";
import { notifyOwner } from "../services/whatsapp.js";
import { linkContactEmail, findContact } from "../db.js";

/**
 * Tool definitions (Anthropic JSON schema) + their implementations.
 * Descriptions state WHEN to call each tool, not just what it does.
 *
 * Tools are split into sets per channel:
 *  - owner/email channels get the full set (trusted or semi-trusted flows)
 *  - whatsapp-client gets a restricted, contact-scoped set so a stranger
 *    messaging the business number can only see and change THEIR OWN
 *    appointments, never the rest of the calendar.
 */

const fullToolDefinitions = [
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
      "Create a new calendar appointment. Call when the owner asks to schedule something, or when an email participant has agreed on a specific time for a new meeting. When the appointment is for a specific person, include their email in attendees and/or their WhatsApp number in contact_wa_id so the appointment is linked to them.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "Start, ISO 8601 with offset" },
        end: { type: "string", description: "End, ISO 8601 with offset" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses" },
        contact_wa_id: { type: "string", description: "WhatsApp number of the person this appointment is with, if known" },
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
    name: "lookup_contact",
    description:
      "Look up a known contact by email or WhatsApp number, returning their linked identities (name, email, WhatsApp). Call when handling an email and you want to know if the sender also talks to you on WhatsApp, or vice versa - so context can be connected across channels.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        wa_id: { type: "string", description: "WhatsApp number, digits only" },
      },
    },
  },
  {
    name: "notify_owner",
    description:
      "Send a short WhatsApp message to the owner. Call after autonomous actions (rescheduled an appointment from an email or a client chat, sent availability to someone) or to ask the owner a question you cannot answer yourself. Do NOT call when you are already talking to the owner on WhatsApp - just answer directly.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
];

/** Restricted, contact-scoped tools for unknown people messaging the business number. */
const clientToolDefinitions = [
  fullToolDefinitions.find((t) => t.name === "find_free_slots"),
  {
    name: "get_my_appointments",
    description:
      "List the upcoming appointments of the person you are currently chatting with (and only theirs). Call before answering any question about their bookings or before rescheduling/cancelling.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a new appointment for the person you are chatting with. Only call after they explicitly confirmed a specific time that find_free_slots returned. The appointment is automatically linked to their WhatsApp number.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. \"Haircut - Dana\" or \"Meeting with Dana Levi\"" },
        start: { type: "string", description: "Start, ISO 8601 with offset" },
        end: { type: "string", description: "End, ISO 8601 with offset" },
        notes: { type: "string", description: "Anything the client mentioned that the owner should know" },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "reschedule_my_appointment",
    description:
      "Move one of the current client's own appointments to a new time they confirmed. Get the event_id from get_my_appointments. Fails if the appointment does not belong to this client.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        start: { type: "string", description: "New start, ISO 8601 with offset" },
        end: { type: "string", description: "New end, ISO 8601 with offset" },
      },
      required: ["event_id", "start", "end"],
    },
  },
  {
    name: "cancel_my_appointment",
    description:
      "Cancel one of the current client's own appointments, after they confirmed they want to cancel. Fails if the appointment does not belong to this client.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "save_my_email",
    description:
      "Store the email address of the person you are chatting with, linking their WhatsApp and email identities. Call when a client shares their email (e.g. to receive a calendar invite or confirmation).",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
      },
      required: ["email"],
    },
  },
  fullToolDefinitions.find((t) => t.name === "notify_owner"),
];

export function toolsForChannel(channel) {
  return channel === "whatsapp-client" ? clientToolDefinitions : fullToolDefinitions;
}

// ---------------------------------------------------------------------------

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
      privateProps: input.contact_wa_id ? { waContact: input.contact_wa_id } : undefined,
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
  lookup_contact: (input) => {
    const contact = findContact({ waId: input.wa_id, email: input.email });
    return contact
      ? { name: contact.name, email: contact.email, whatsapp: contact.wa_id }
      : { found: false };
  },
  notify_owner: async (input) => {
    await notifyOwner(input.message);
    return { notified: true };
  },

  // --- client-scoped tools (require ctx.contact) ---------------------------

  get_my_appointments: (_input, ctx) =>
    calendar.listEventsForContact({ waId: ctx.contact?.wa_id, email: ctx.contact?.email }),

  book_appointment: (input, ctx) => {
    const who = ctx.contact?.name || ctx.contact?.wa_id || "client";
    return calendar.createEvent({
      title: input.title,
      start: input.start,
      end: input.end,
      description: [
        `Booked via WhatsApp by ${who} (${ctx.contact?.wa_id || "unknown"})`,
        input.notes ? `Notes: ${input.notes}` : null,
      ].filter(Boolean).join("\n"),
      attendees: ctx.contact?.email ? [ctx.contact.email] : [],
      sendInvites: Boolean(ctx.contact?.email),
      privateProps: { waContact: ctx.contact?.wa_id || "" },
    });
  },

  reschedule_my_appointment: async (input, ctx) => {
    await assertOwnership(input.event_id, ctx);
    return calendar.updateEvent({ eventId: input.event_id, start: input.start, end: input.end });
  },

  cancel_my_appointment: async (input, ctx) => {
    await assertOwnership(input.event_id, ctx);
    return calendar.deleteEvent({ eventId: input.event_id });
  },

  save_my_email: (input, ctx) => {
    if (!ctx.contact?.wa_id) throw new Error("No WhatsApp contact in this conversation");
    const updated = linkContactEmail(ctx.contact.wa_id, input.email);
    ctx.contact.email = updated.email;
    return { saved: true, email: updated.email };
  },
};

async function assertOwnership(eventId, ctx) {
  const event = await calendar.getEvent(eventId);
  if (!calendar.eventBelongsToContact(event, { waId: ctx.contact?.wa_id, email: ctx.contact?.email })) {
    throw new Error("This appointment does not belong to the current client; action refused.");
  }
}

/**
 * @param {string} name tool name
 * @param {object} input tool input from the model
 * @param {object} ctx { channel, contact: {wa_id, email, name} | null }
 */
export async function executeTool(name, input, ctx = {}) {
  const allowed = toolsForChannel(ctx.channel).some((t) => t.name === name);
  if (!allowed) {
    return { isError: true, content: `Tool ${name} is not available on this channel.` };
  }
  const handler = handlers[name];
  if (!handler) {
    return { isError: true, content: `Unknown tool: ${name}` };
  }
  try {
    const result = await handler(input, ctx);
    return { isError: false, content: JSON.stringify(result) };
  } catch (err) {
    console.error(`[tool:${name}] failed:`, err);
    return { isError: true, content: `Error: ${err.message}` };
  }
}
