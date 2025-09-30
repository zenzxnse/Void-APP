// src/events/messageAutoMod.js
import {
  Events
} from 'discord.js';
import { Automod } from '../utils/automod/AutoMod.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ mod: 'automod:processor' });


export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message, client) {
    if (message.author?.bot) return; 
    if (!client.autoMod) {
        return;
    }
    try {
      await Automod.handle(message, client);
    } catch (error) {
      log.error({ error }, 'Automod: Failed to process message');  
    }
  }
};