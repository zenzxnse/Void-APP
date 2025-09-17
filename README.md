---

# Void Bot

A modern, production-grade Discord bot built with **Node.js** and **discord.js v14**.
Void Bot emphasizes **reliability**, **observability**, and **developer ergonomics**: file-based loaders, centralized middleware, structured logging (Pino), and fast button routing with **Aho–Corasick**.

---

## ✨ Features

* **Modular, file-based handlers**
  Add a command, button, or event by creating a file—no central registry to edit. Loaders recurse subfolders for clean grouping (e.g., `buttons/rps/*`).

* **High-performance interaction routing**

  * **Slash Commands**: Standard, predictable.
  * **Buttons**:

    * **Exact IDs** (`customId`, `customIds`)
    * **Aho–Corasick keywords** (`keyword`, `keywords`) for fast prefix/contains matching (great for namespacing like `rps_`, `poll_`).
    * **Custom match functions** (`match(id, interaction, client)`) for dynamic logic.

* **Concurrent loading**
  Uses `p-limit` to import handlers concurrently (configurable via env), minimizing startup time.

* **Centralized middleware**
  One place for permissions, cooldowns, guild/DM checks, owner checks—keep handlers focused on business logic.

* **Structured logging (Pino)**

  * Dev: pretty, colorized logs (`pino-pretty`)
  * Prod: JSON logs with optional redaction (`LOG_REDACT`) for secure ingestion (e.g., Loki, ELK, Datadog).

* **Integrated telemetry**
  `client.stats` tracks: loaded counts, exec counts per command/button, denials, and error totals. Surface via `/stats` or logs.

* **Graceful error handling & shutdown**
  Process-level traps for `unhandledRejection`/`uncaughtException` and graceful `SIGINT`/`SIGTERM`.

* **Environment-aware config**
  Clean split: **secrets in `.env`**, team-safe settings in **`src/core/config.js`**.

---

## 📦 Project Structure (evolving)

```
src/
  components/
    buttons/            # Button handlers (recurse subfolders)
  commands/             # Slash commands
  core/                 # Core utilities & runtime
    config.js           # Non-secret app config (committable)
    logger.js           # Pino logger + helpers
    middleware.js       # Shared validation (perms, cooldowns, etc.)
    VoidApp.js          # Client bootstrap (traps, loading, login)
  events/               # Discord.js events (e.g., ready, guildCreate)
  loaders/              # File-based loaders
    buttonLoader.js     # (If you keep a separate loader) - else using core/buttonHandler.js
    commandLoader.js
    eventLoader.js
  index.js              # App entrypoint
.env                    # Secrets (DO NOT COMMIT)
.env.example            # Template for secrets
package.json
```

> **Note:** The button system is implemented in **`src/core/buttonHandler.js`** and **owns** button dispatch. Keep `events/interactionCreate.js` focused on **commands only**, or remove its button logic to avoid double-handling.

---

## 🚀 Quickstart

### Prerequisites

* **Node.js 18+**
* A Discord application & bot token

### Install dependencies

```bash
npm i discord.js dotenv p-limit pino pino-pretty aho-corasick
```

### Configure secrets (`.env`)

Copy `.env.example` to `.env`, then fill values:

```dotenv
VOID_TOKEN="YOUR_DISCORD_BOT_TOKEN"
APP_ID="YOUR_DISCORD_APP_ID"
GUILD_ID="YOUR_DEV_GUILD_ID"   # for fast, guild-scoped command registration
GEMINI_API_KEY="optional"
GROQ_KEY="optional"
```

### Configure non-secrets (`src/core/config.js`)

```js
export default {
  COMMANDS_FOLDER: 'commands',
  EVENTS_FOLDER: 'events',
  BUTTONS_FOLDER: 'buttons',
  GLOBAL: false,                   // true = register slash commands globally (slow propagation)
  AI_ALLOWED_LIST: [747400496402268243], // example
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  // Comma- or space-separated redaction paths (pino supports array too)
  LOG_REDACT: 'token,authorization,headers.authorization,env.VOID_TOKEN',
};
```

> **Precedence:** Secrets live in `.env` (loaded by `dotenv`). Non-secrets (safe to commit) live in `config.js`.

---

## 🧰 NPM Scripts

```bash
# Development (auto-restart, pretty logs)
npm run dev

# Production start (JSON logs)
npm run start

# Register slash commands (reads COMMANDS_FOLDER)
# - Guild scope by default (instant updates)
# - Set GLOBAL=true in config.js for global scope (can take up to an hour)
npm run register
```

*(Define these in `package.json` if not present.)*

---

## 🔑 OAuth2 & Intents

* **Scopes:** `bot applications.commands`
* **Recommended bot permissions:**
  At minimum: `SendMessages`, `EmbedLinks`, `UseExternalEmojis`
* **Intents (in client):** `Guilds`, `GuildMessages`, `MessageContent` (document why you need MessageContent if enabled)

---

## 🧩 Handlers

### Slash Commands

**File:** `src/commands/user.js`

```js
import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('user')
  .setDescription('Shows info about the user');

export const cooldownMs = 5000; // optional (handled in middleware)

export async function execute(interaction) {
  await interaction.reply(`This command was run by ${interaction.user.username}.`);
}
```

**Notes**

* Loader validates `data.name`, `execute`.
* If you change names/options, re-run `npm run register`.

---

### Buttons (via `core/buttonHandler.js`)

**What the loader understands**

* `customId: string` (exact)
* `customIds: string[]` (multiple exact)
* `keyword: string` / `keywords: string[]` (Aho–Corasick fast matching; store lowercased)
* `match(id, interaction, client)` → `boolean | object | Promise<...>` (custom logic)
* Optional metadata: `defer`, `ephemeral`, `cooldownMs`, `requiredPerms`, `guildOnly`, etc.

**Minimal example** – exact IDs:

```js
// src/components/buttons/rps/rpsButtons.js
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const customIds = ['rps_rock', 'rps_paper', 'rps_scissor']; // routing keys
export const defer = true; // auto-defer reply (see note below)

export const rpsButtons = [
  new ButtonBuilder().setCustomId('rps_rock').setLabel('Rock').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('rps_paper').setLabel('Paper').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('rps_scissor').setLabel('Scissors').setStyle(ButtonStyle.Primary),
];

export async function execute(interaction) {
  const [, choice] = interaction.customId.split('_'); // 'rock' | 'paper' | 'scissor'
  // After defer, we must edit the reply:
  await interaction.editReply({ content: `You chose **${choice}**!`, components: [] });
}
```

**A keyword/prefix example** – Aho–Corasick:

```js
export const keywords = ['poll_', 'poll:']; // any ID containing either will match
export const defer = 'reply'; // auto-defer with a reply

export async function execute(interaction) {
  // context.match is set to the keyword that matched (if you use it in your handler)
  await interaction.editReply({ content: `Received poll action: ${interaction.customId}` });
}
```

> **Why have `customIds` if we can set IDs on `ButtonBuilder`?**
> The builder defines the ID *on the message component*. The loader needs to know what **incoming** IDs it should route to this file. Declaring `customId`/`customIds`/`keywords` in the handler connects the incoming interaction to your file. (You’ll still set the actual IDs on the built buttons you send.)

---

## 🧱 Middleware (centralized)

Add properties to any handler (command or button), and middleware enforces them:

* `cooldownMs`
* `requiredPerms`, `requiredBotPerms`
* `guildOnly`, `dmPermission`
* `ownerOnly`, `ownerBypass`

This keeps handlers focused on the “what”, not the “can we”.

---

## 🧪 Example: Sending buttons from a command

```js
// src/commands/rps.js
import { SlashCommandBuilder, ActionRowBuilder } from 'discord.js';
import { rpsButtons } from '../components/buttons/rps/rpsButtons.js';

export const data = new SlashCommandBuilder()
  .setName('rps')
  .setDescription('Play Rock/Paper/Scissors with the bot');

export async function execute(interaction) {
  const row = new ActionRowBuilder().addComponents(rpsButtons);
  await interaction.reply({ content: 'Pick one:', components: [row] });
}
```

---

## 🪵 Logging

Powered by **Pino** via `src/core/logger.js`.

* **Dev**: pretty, color, human timestamps
* **Prod**: JSON logs; configure redaction via `LOG_REDACT` (comma/space separated)

Helpers:

* `createLogger({ mod })` – module-scoped logger
* `forInteraction(interaction)` – child logger enriched with `interactionId`, `guildId`, `channelId`, `userId`, etc.

---

## ⚠️ Ephemeral replies & the “Unknown interaction (10062)” error

* **Always reply or defer within \~3 seconds.**
  Heavy work? **Defer first**, then `editReply`.

* **Deprecated `ephemeral` warning**
  Some low-level REST paths warn that `ephemeral` is deprecated in favor of **flags**.

  * High-level `discord.js` helpers accept `ephemeral: true` and set flags internally.
  * If you call low-level REST, set `flags: 1 << 6` (64) for ephemeral.

Examples:

```js
// High-level (discord.js) – OK
await interaction.deferReply({ ephemeral: true });    // or reply({ ephemeral: true })

// Low-level (REST) – prefer flags
await interaction.deferReply({ flags: 1 << 6 });      // EPHEMERAL
```

* **Duplicate listeners cause chaos**
  Let **`core/buttonHandler.js`** own buttons.
  If you also handle buttons inside `events/interactionCreate.js`, you’ll see unsupported type logs or double-acks.

---

## 🧭 Configuration Reference

| Key                    | Where                  | Type    | Default       | Notes                                       |       |      |      |       |         |
| ---------------------- | ---------------------- | ------- | ------------- | ------------------------------------------- | ----- | ---- | ---- | ----- | ------- |
| `COMMANDS_FOLDER`      | `core/config.js`       | string  | `commands`    | Folder name (relative to `src/`)            |       |      |      |       |         |
| `EVENTS_FOLDER`        | `core/config.js`       | string  | `events`      | Folder name (relative to `src/`)            |       |      |      |       |         |
| `BUTTONS_FOLDER`       | `core/config.js`       | string  | `buttons`     | Folder name (relative to `src/components/`) |       |      |      |       |         |
| `GLOBAL`               | `core/config.js`       | boolean | `false`       | Slash command registration scope            |       |      |      |       |         |
| `NODE_ENV`             | `core/config.js` / env | string  | `development` | Influences logging & dev checks             |       |      |      |       |         |
| `LOG_LEVEL`            | `core/config.js` / env | string  | `info`        | \`trace                                     | debug | info | warn | error | fatal\` |
| `LOG_REDACT`           | `core/config.js` / env | string  | `…`           | Comma/space-separated redaction paths       |       |      |      |       |         |
| `*_IMPORT_CONCURRENCY` | env                    | number  | `10`          | `COMMAND_`, `EVENT_`, `BUTTON_`             |       |      |      |       |         |

**Secrets (in `.env`):**

* `VOID_TOKEN`, `APP_ID`, `GUILD_ID`
* `GEMINI_API_KEY`, `GROQ_KEY` (optional)

---

## 🛠 Troubleshooting

* **`Unknown interaction (10062)`**
  You didn’t respond/defer in time, or there’s a duplicate listener. Defer early for heavy ops; ensure button handling isn’t duplicated in `interactionCreate`.

* **“Supplying 'ephemeral' is deprecated” warning**
  You’re hitting a low-level REST path. Switch to `{ flags: 1 << 6 }` or keep using high-level `discord.js` helpers with `ephemeral: true`.

* **No handlers loaded**
  Check your folder names in `config.js`. Loaders recurse subfolders. If you want startup to fail when no buttons are present, set `FAIL_ON_EMPTY_BUTTONS=true`.

* **ID collisions**
  Loader throws on duplicate `customId` or `keyword`. For AC, keywords are lowercased; IDs are searched lowercased—be consistent.

---

## 🧭 Roadmap

* **AI server bootstrap**
  Generate channel/category/role layouts, apply templates, and guided setup flows.
* **Policy guardrails**
  Allowlist + opt-in prompts to gate AI actions.
* **Observability**
  `/stats` expansion, health endpoints, optional Prometheus.
* **Deployment**
  Dockerfile, PM2/Systemd examples.

---

## 📄 License

MIT (or your choice). Add a `LICENSE` file if you haven’t yet.

---

## 🙌 Contributing

* Keep handlers small and declarative.
* Prefer middleware flags over in-handler checks.
* Use `createLogger({ mod: '...' })`; avoid `console.*` in production code.
* Run `npm run register` after command shape changes.

---

### One-line install (all used runtime deps)

```bash
npm i discord.js dotenv p-limit pino pino-pretty aho-corasick
```

> If you’re using TypeScript later, add `typescript ts-node @types/node` and adjust the scripts.

---

