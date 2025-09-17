// src/events/guildCreate.js
import { ensureGuildRow } from '../core/db/guild.js';
import { createLogger } from '../core/logger.js';
const log = createLogger({ mod: 'guildCreate' });

export default {
  name: 'guildCreate',
  async execute(guild) {
    await ensureGuildRow(guild.id);
    log.info({ guildId: guild.id, name: guild.name }, 'Ensured guild_config on join');
  }
};
