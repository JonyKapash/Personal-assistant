# Personal Appointment Assistant

An AI personal assistant (powered by Claude) that manages your appointments end to end:

- **Reads your inbox** — when someone emails asking to reschedule, it finds the appointment in your Google Calendar, checks when you're actually free, and replies with available times. When they confirm, it updates the calendar and pings you on WhatsApp.
- **Lives on WhatsApp** — message it from your own WhatsApp number: *"what's my schedule today?"*, *"book a dentist appointment next Tuesday at 10 and email the clinic"*, *"move my 3pm to Thursday"*.
- **Sends emails for you** — proposals, confirmations and coordination emails are sent from your Gmail, threaded correctly, signed on your behalf.
- **Keeps you in the loop** — any autonomous action (a reschedule it negotiated by email, an event it changed) triggers a short WhatsApp notification to you.

## Architecture

```
                    ┌─────────────────────────────┐
 Gmail inbox ──────►│                             │────► Google Calendar
 (poll for new      │   Claude agent (tool use)   │      (events, free/busy)
  emails)           │   claude-opus-4-8           │
                    │                             │────► Gmail send (replies)
 WhatsApp webhook ─►│  tools: get_events,         │
 (your messages)    │  find_free_slots,           │────► WhatsApp Cloud API
                    │  create/update/delete_event,│      (replies + notifications)
                    │  reply_to_email, send_email,│
                    │  notify_owner, ...          │
                    └──────────────┬──────────────┘
                                   │
                            SQLite (conversation
                            history per email thread
                            / WhatsApp chat)
```

Each email thread and the WhatsApp chat keep their own conversation history, so the assistant remembers what times it already proposed when the reply arrives days later.

## Setup

### 1. Prerequisites

- Node.js 20+
- An [Anthropic API key](https://platform.claude.com/)
- A Google account (Gmail + Calendar)
- A [Meta WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) app (optional but recommended)

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

This stores a refresh token at `GOOGLE_TOKEN_PATH` so the assistant can read your inbox, send mail, and manage your calendar.

### 4. WhatsApp Business (Meta)

1. Create a Meta app with the **WhatsApp** product. You get a test phone number immediately; for production, register your own business number.
2. Copy the **permanent access token** and **phone number ID** into `.env`.
3. Configure the webhook in the Meta dashboard:
   - Callback URL: `https://<your-host>/webhooks/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN` from your `.env`
   - Subscribe to the `messages` field.
4. Set `OWNER_WHATSAPP` to **your** personal number (digits only, with country code). Only that number can command the assistant; messages from anyone else are ignored.

For local development, expose the server with a tunnel (e.g. `ngrok http 3000` or `cloudflared tunnel`) and use that URL as the webhook callback.

> Note: with a Meta **test number** you must add your personal number as a recipient in the dashboard, and WhatsApp's 24-hour customer-service window applies — the assistant can always reply to your messages, but unsolicited notifications outside a 24h window require an approved template message in production.

### 5. Run

```bash
npm start
```

The assistant then:
- polls Gmail every `GMAIL_POLL_SECONDS` for unread primary-inbox emails,
- serves the WhatsApp webhook on `PORT`,
- answers you on WhatsApp and handles appointment emails autonomously.

## Try it

- WhatsApp yourself → the business number: **"What's my schedule today?"**
- **"Set a meeting with dana@example.com next Monday at 14:00 about the renovation, and email her an invite."**
- Have someone email you: *"Hi, I can't make our Thursday appointment — can we move it?"* → the assistant replies with your real availability, and once they pick a time, your calendar is updated and you get a WhatsApp notification.

## Safety & privacy notes

- Only `OWNER_WHATSAPP` can issue commands; all other WhatsApp senders are ignored.
- Email senders are treated as untrusted: the agent is instructed to only act on scheduling for their own appointment and never to expose other calendar details. Instructions embedded in emails that try to redirect the assistant are ignored.
- Clearly non-scheduling email (newsletters, receipts) is skipped without action.
- Destructive/ambiguous requests trigger a WhatsApp question to you instead of a guess.
- Secrets live in `.env` (gitignored); the Google token and SQLite database live in `data/` (gitignored).

## Project layout

```
src/
  index.js            entrypoint: web server + email watcher
  config.js           environment configuration
  db.js               SQLite: conversation history, dedupe of processed messages
  server.js           Express app with the WhatsApp webhook
  emailWatcher.js     Gmail inbox poller -> agent
  agent/
    agent.js          Claude agentic loop (tool use, adaptive thinking, prompt caching)
    prompts.js        system prompt
    tools.js          tool definitions + dispatch to services
  services/
    google.js         OAuth2 wiring
    calendar.js       Calendar ops + free-slot computation (free/busy)
    gmail.js          read/parse/send/reply email
    whatsapp.js       Cloud API send + webhook parsing
scripts/
  google-auth.js      one-time OAuth consent flow
```
