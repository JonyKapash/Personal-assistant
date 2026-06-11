# WhatsApp Business Appointment Assistant

A commercial-style AI assistant (powered by Claude) that runs your scheduling entirely through **WhatsApp Business**, with a backend fully synced to your **Google Calendar** and **Gmail**.

**Anyone can message your WhatsApp Business number** — the assistant acts as your front desk:

- **Clients** message the business number to book, reschedule, or cancel appointments. The assistant offers only times you're genuinely free, books straight into your calendar, and can never see or leak anything else on your schedule.
- **You** (the owner) message the same number from your personal phone and get full admin control: *"what's my schedule today?"*, *"move my 3pm to Thursday"*, *"email dana@... and coordinate a meeting next week"*.
- **Email sync** — incoming appointment emails are handled autonomously: the assistant finds the event, checks real availability, negotiates a new time over email, and updates the calendar when it's agreed.
- **One identity across channels** — a contact registry links a person's WhatsApp number and email, so a client who emails about the appointment they booked on WhatsApp is recognized as the same person.
- **You're always in the loop** — every booking, change, or cancellation the assistant makes (and any calendar change made outside it, from any device) triggers a WhatsApp notification to you.

## Architecture

```
                          ┌────────────────────────────────────┐
 WhatsApp Business ──────►│            Role router             │
 webhook (anyone)         │  owner number → admin persona      │
                          │  other number → client persona     │
                          └───────────────┬────────────────────┘
                                          ▼
 Gmail inbox ────────────►┌────────────────────────────────────┐
 (poller)                 │     Claude agent (tool use)        │────► Google Calendar
                          │                                    │      (live source of truth)
 Calendar watcher ───────►│  owner/email tools: full calendar, │
 (external changes)       │   send/reply email, contacts       │────► Gmail send
                          │  client tools: free slots + OWN    │
                          │   appointments only (enforced      │────► WhatsApp Cloud API
                          │   server-side, not just prompted)  │      (replies + owner alerts)
                          └───────────────┬────────────────────┘
                                          │
                                SQLite: conversation history per
                                chat/thread, contact registry,
                                dedupe, watcher state
```

Key design points (the "commercial software" bits):

- **Calendar is the single source of truth.** Nothing is cached or shadowed; every availability check and change hits Google Calendar live, so it's always in sync with what you see on your phone.
- **Server-side authorization, not prompt-only.** Client conversations get a restricted toolset; ownership of an appointment is verified in code (events are tagged with the booker's WhatsApp id / attendee email) before any reschedule/cancel executes. A client cannot list the calendar at all.
- **Webhook signature verification** (`X-Hub-Signature-256` with your Meta app secret) so only Meta can deliver webhook events.
- **Idempotent message handling** — webhook retries and overlapping polls can't double-process a message or email.
- **Per-conversation memory** — each WhatsApp chat and email thread keeps its own history, so multi-day negotiations ("the times you offered Tuesday") retain context.
- **Prompt caching + adaptive thinking** on `claude-opus-4-8` keeps responses fast and costs down.

## Setup

### 1. Prerequisites

- Node.js 20+
- An [Anthropic API key](https://platform.claude.com/)
- A Google account (Gmail + Calendar)
- A [Meta WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) app

### 2. Install

```bash
npm install
cp .env.example .env   # then fill in the values
```

### 3. Google (Gmail + Calendar)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API** and **Google Calendar API**.
2. Create an **OAuth client ID** of type **Desktop app**; put the client ID/secret in `.env`.
3. Add your Google account as a test user on the OAuth consent screen.
4. Run the one-time authorization:

```bash
npm run auth:google
```

### 4. WhatsApp Business (Meta)

1. Create a Meta app with the **WhatsApp** product. You get a test number immediately; register your real business number for production.
2. Copy the **permanent access token**, **phone number ID**, and **app secret** into `.env`.
3. Configure the webhook in the Meta dashboard:
   - Callback URL: `https://<your-host>/webhooks/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the `messages` field.
4. Set `OWNER_WHATSAPP` to **your** personal number (digits only, with country code) — that number gets admin control; every other number is served as a client.
5. Set `BUSINESS_NAME` to what clients should hear (e.g. "Yoni's Studio").

For local development, expose the server with a tunnel (`ngrok http 3000` / `cloudflared tunnel`).

### 5. Run

```bash
npm start
```

## What it looks like in practice

**A client writes to the business number:**
> *Client:* Hi, do you have anything available this week?
> *Assistant:* Hi! I have Wednesday 10:00, Wednesday 15:30, or Thursday 11:00. Would any of these work?
> *Client:* Thursday 11 works. It's Dana.
> *Assistant:* Booked — Thursday, 12 June at 11:00. Want a calendar invite by email?
> *(You get a WhatsApp ping: "New booking: Dana, Thu 12 Jun 11:00.")*

**Someone emails you "can we move our Thursday meeting?":**
The assistant looks up the event, checks your real availability, replies with options, and when they answer "Friday 10am works", it moves the event, confirms by email, and pings you on WhatsApp.

**You write from your own phone:**
> *You:* What's my day tomorrow?
> *Assistant:* You have 3 appointments: 09:30 Dana (haircut), 12:00 dentist, 16:00 call with Avi.

**Someone moves a meeting from their own calendar app:** the calendar watcher spots the external change and pings you.

## Production notes (WhatsApp platform rules)

- **24-hour window:** WhatsApp lets a business send free-form messages only within 24h of the user's last message. Replies to clients and to you are always fine (they just messaged you). Proactive notifications (e.g. a calendar-change alert when you haven't texted the bot in a day) require an approved **template message** in production — add one in the Meta dashboard and send it via the same Cloud API endpoint.
- **Business verification** and a display name review are required by Meta to lift messaging limits on a production number.
- This deployment serves **one business** (your calendar/inbox). Turning it into multi-tenant SaaS means adding per-customer onboarding — Google OAuth per customer, Meta **Embedded Signup** for their WhatsApp numbers, and a tenant column on the data model. The agent/tool architecture stays the same.

## Safety & privacy

- Clients can only ever see free/busy through offered slots and their **own** appointments — enforced in code (`assertOwnership`), not only in the prompt.
- Only `OWNER_WHATSAPP` gets admin tools; webhook payloads are signature-verified.
- Email senders and WhatsApp clients are treated as untrusted input; instructions embedded in their messages that try to redirect the assistant are ignored by policy.
- Clearly non-scheduling email (newsletters, receipts) is skipped without action.
- Secrets live in `.env` (gitignored); the Google token and SQLite database live in `data/` (gitignored).

## Project layout

```
src/
  index.js            entrypoint: web server + email & calendar watchers
  config.js           environment configuration
  db.js               SQLite: conversations, contacts, dedupe, watcher state
  server.js           Express app: WhatsApp webhook, signature check, role routing
  emailWatcher.js     Gmail inbox poller -> agent
  calendarWatcher.js  notifies owner of calendar changes made outside the assistant
  agent/
    agent.js          Claude agentic loop (tool use, adaptive thinking, prompt caching)
    prompts.js        system prompt (owner / client / email personas)
    tools.js          per-channel toolsets + server-side ownership enforcement
  services/
    google.js         OAuth2 wiring
    calendar.js       Calendar ops, free-slot computation, contact-scoped queries
    gmail.js          read/parse/send/reply email
    whatsapp.js       Cloud API send + webhook parsing
scripts/
  google-auth.js      one-time OAuth consent flow
```
