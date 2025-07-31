// src/VoidApp.js
// Minimal main bot class — uses existing handlers, no auto-registration, no extra loaders.

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { logger } from './core/logger.js';
import loadCommands from './commandHandler.js';
import loadEvents from './eventHandler.js';

export default class VoidApp extends Client {
  #token;

  constructor(token) {
    if (!token) throw new Error('VOID_TOKEN is missing or empty');

    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [
        Partials.Message,
        Partials.Channel,
        // Partials.Reaction,
      ],
      allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    });

    this.#token = token;

    // Telemetry for middleware and /stats
    this.stats = {
      commandExecs: new Map(),
      loaded: { commands: 0, events: 0, buttons: 0, selects: 0, modals: 0 },
      denies: { cooldown: 0, perms: 0, owner: 0, guildOnly: 0, dmBlocked: 0 },
      errors: 0,
    };

    this.once('ready', () => {
      logger.info({ tag: this.user?.tag ?? 'unknown' }, 'Bot online');
    });

    // Basic client diagnostics
    this.on('error', (err) => logger.error({ err }, '[CLIENT ERROR]'));
    this.on('warn', (msg) => logger.warn({ msg }, '[CLIENT WARN]'));

    // Process-level traps
    if (process.listenerCount('unhandledRejection') === 0) {
      process.on('unhandledRejection', (reason, p) =>
        logger.error({ reason, promise: p }, 'Unhandled Rejection')
      );
    }
    if (process.listenerCount('uncaughtException') === 0) {
      process.on('uncaughtException', (err) =>
        logger.error({ err }, 'Uncaught Exception')
      );
    }

    // Graceful shutdown
    const shutdown = async (sig) => {
      logger.info({ sig }, 'Shutting down');
      try { await this.destroy(); } finally { process.exit(0); }
    };
    if (process.listenerCount('SIGINT') === 0) process.once('SIGINT', () => shutdown('SIGINT'));
    if (process.listenerCount('SIGTERM') === 0) process.once('SIGTERM', () => shutdown('SIGTERM'));
  }

  async start() {
    logger.info('Starting Void Bot…');
    try {
      // Load handlers you actually have
      await Promise.all([
        loadCommands(this),
        loadEvents(this),
      ]);

      // Update loaded stats if your loaders fill these
      this.stats.loaded.commands = this.commands?.size ?? 0;
      // If your event loader keeps a collection, set it here; else skip.
      // this.stats.loaded.events = this.eventHandlers?.size ?? 0;

      await this.login(this.#token);
    } catch (err) {
      logger.error({ err }, 'Failed to start/login');
      process.exitCode = 1;
    }
  }
}
