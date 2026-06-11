import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
  },
  owner: {
    name: process.env.OWNER_NAME || "Owner",
    email: required("OWNER_EMAIL").toLowerCase(),
    whatsapp: process.env.OWNER_WHATSAPP || "",
  },
  businessName: process.env.BUSINESS_NAME || process.env.OWNER_NAME || "the business",
  timezone: process.env.TIMEZONE || "UTC",
  scheduling: {
    workDayStart: process.env.WORK_DAY_START || "09:00",
    workDayEnd: process.env.WORK_DAY_END || "18:00",
    defaultMinutes: parseInt(process.env.DEFAULT_APPOINTMENT_MINUTES || "60", 10),
  },
  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    tokenPath: process.env.GOOGLE_TOKEN_PATH || "./data/google-token.json",
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    pollSeconds: parseInt(process.env.GMAIL_POLL_SECONDS || "60", 10),
    calendarWatchSeconds: parseInt(process.env.CALENDAR_WATCH_SECONDS || "300", 10),
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    apiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
    enabled: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
  },
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
  },
  dbPath: process.env.DB_PATH || "./data/assistant.db",
};
