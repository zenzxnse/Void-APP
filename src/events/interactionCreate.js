// Event handler for all interactions: commands, buttons, selects, modals.
// Dispatches to respective handlers with middleware for commands.
// Assumes client has: commands (Map), buttonHandlers/selectHandlers/modalHandlers (tri-store: {exact: Map, patterns: [], matches: []}).

import { runMiddleware } from '../core/middleware.js';
import { logger } from '../core/logger.js';

export default {
  name: 'interactionCreate',
  async execute(interaction) {
    // Central dispatcher for all interaction types
    try {
      if (
        interaction.isChatInputCommand() ||
        interaction.isUserContextMenuCommand?.() ||
        interaction.isMessageContextMenuCommand?.()
      ) {
        await handleCommand(interaction);
      } else if (interaction.isButton()) {
        await handleButton(interaction);
      } else if (isAnySelectMenu(interaction)) {
        await handleSelect(interaction);
      } else if (interaction.isModalSubmit()) {
        await handleModal(interaction);
      } else if (interaction.isAutocomplete?.()) {
        // Autocomplete must be answered with choices, not reply()
        try { await interaction.respond([]); } catch {}
        // no warning here to avoid noisy logs; empty list is a valid noop
        return;
      } else {
        logger.warn({ type: interaction.type }, 'Unsupported interaction');
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'This interaction is not supported.', ephemeral: true }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err, interactionId: interaction.id }, 'Interaction dispatch failed');
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An unexpected error occurred.', ephemeral: true }).catch(() => {});
      }
      if (interaction.client?.stats) {
        interaction.client.stats.errors = (interaction.client.stats.errors || 0) + 1;
      }
    }
  },
};

// Select helper compatible with Discord.js v14
function isAnySelectMenu(interaction) {
  return (
    interaction.isStringSelectMenu?.() ||
    interaction.isUserSelectMenu?.() ||
    interaction.isRoleSelectMenu?.() ||
    interaction.isChannelSelectMenu?.() ||
    interaction.isMentionableSelectMenu?.()
  );
}

// Helper: Find matching handler from tri-store and extract params
function findMatchingHandler(store, id) {
  if (!store || !id) return null;
  const exact = store.exact?.get ? store.exact : { get: () => undefined };
  const matchesArr = Array.isArray(store.matches) ? store.matches : [];
  const patternsArr = Array.isArray(store.patterns) ? store.patterns : [];

  let handler = exact.get(id);
  let params;
  if (handler) return { handler, params };

  const matchEntry = matchesArr.find(m => {
    try {
      const res = m.match(id);
      if (res) {
        params = typeof res === 'object' ? res : {};
        return true;
      }
    } catch (e) {
      logger.error({ err: e }, 'match() threw');
    }
    return false;
  });
  if (matchEntry) return { handler: matchEntry.handler, params };

  const patternMatch = patternsArr.find(p => {
    if (p.pattern.global || p.pattern.sticky) p.pattern.lastIndex = 0;
    return p.pattern.test(id);
  });
  if (patternMatch) return { handler: patternMatch.handler, params };

  return null;
}

// Command handler with middleware
async function handleCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn({ cmd: interaction.commandName }, 'Unknown command');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'This command is not available.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  const res = await runMiddleware(interaction, command);
  if (!res.ok) return;

  const stats = interaction.client?.stats;
  if (stats?.commandExecs) {
    const n = stats.commandExecs.get(command.data.name) || 0;
    stats.commandExecs.set(command.data.name, n + 1);
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error({ err }, `Command execute failed: ${interaction.commandName}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Error executing command.', ephemeral: true }).catch(() => {});
    }
    if (interaction.client?.stats) {
      interaction.client.stats.errors = (interaction.client.stats.errors || 0) + 1;
    }
  }
}

// Button handler
async function handleButton(interaction) {
  const { handler, params } = findMatchingHandler(interaction.client.buttonHandlers, interaction.customId) || {};
  if (!handler) {
    logger.warn({ id: interaction.customId }, 'Unknown button');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'That button is no longer active.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (handler.defer) {
    try {
      if (handler.defer === 'update' || handler.defer === true) await interaction.deferUpdate();
      else if (handler.defer === 'reply') await interaction.deferReply({ ephemeral: handler.ephemeral ?? true });
    } catch (err) {
      logger.error({ err }, 'Button defer failed');
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Error processing button.', ephemeral: true }).catch(() => {});
      }
      return;
    }
  }

  try {
    await handler.execute(interaction, params ?? {});
  } catch (err) {
    logger.error({ err }, 'Button execute failed');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Error processing button.', ephemeral: true }).catch(() => {});
    }
    if (interaction.client?.stats) {
      interaction.client.stats.errors = (interaction.client.stats.errors || 0) + 1;
    }
  }
}

// Select handler
async function handleSelect(interaction) {
  const { handler, params } = findMatchingHandler(interaction.client.selectHandlers, interaction.customId) || {};
  if (!handler) {
    logger.warn({ id: interaction.customId }, 'Unknown select');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'That menu is no longer active.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (handler.defer) {
    try {
      if (handler.defer === 'update' || handler.defer === true) await interaction.deferUpdate();
      else if (handler.defer === 'reply') await interaction.deferReply({ ephemeral: handler.ephemeral ?? true });
    } catch (err) {
      logger.error({ err }, 'Select defer failed');
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Error processing menu.', ephemeral: true }).catch(() => {});
      }
      return;
    }
  }

  try {
    await handler.execute(interaction, params ?? {});
  } catch (err) {
    logger.error({ err }, 'Select execute failed');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Error processing menu.', ephemeral: true }).catch(() => {});
    }
    if (interaction.client?.stats) {
      interaction.client.stats.errors = (interaction.client.stats.errors || 0) + 1;
    }
  }
}

// Modal handler
async function handleModal(interaction) {
  const { handler, params } = findMatchingHandler(interaction.client.modalHandlers, interaction.customId) || {};
  if (!handler) {
    logger.warn({ id: interaction.customId }, 'Unknown modal');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'That modal is no longer active.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (handler.defer) {
    try {
      await interaction.deferReply({ ephemeral: handler.ephemeral ?? true });
    } catch (err) {
      logger.error({ err }, 'Modal defer failed');
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Error submitting modal.', ephemeral: true }).catch(() => {});
      }
      return;
    }
  }

  try {
    await handler.execute(interaction, params ?? {});
  } catch (err) {
    logger.error({ err }, 'Modal execute failed');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Error submitting modal.', ephemeral: true }).catch(() => {});
    }
    if (interaction.client?.stats) {
      interaction.client.stats.errors = (interaction.client.stats.errors || 0) + 1;
    }
  }
}