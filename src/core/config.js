// src/core/config.js
export default {
  COMMANDS_FOLDER: "commands",
  EVENTS_FOLDER: "events",
  BUTTONS_FOLDER: "buttons",
  GLOBAL: false, // false = guild-only (for testing)
  AI_ALLOWED_LIST: ["747400496402268243"],
  NODE_ENV: "development", // 'production' or 'development'
  GUILD_IDS: [
    "1411475284452053084"
  ],
  LOG_LEVEL: "info",
  LOG_REDACT: "token,authorization,headers.authorization,env.VOID_TOKEN",
  BUTTON_IMPORT_CONCURRENCY: 10, // number
  FAIL_ON_EMPTY_BUTTONS: false, // boolean
  BUTTON_DM_FALLBACK: false, // boolean
};
