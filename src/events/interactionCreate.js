// src/events/interactionCreate.js
import { runMiddleware } from '../core/middleware/middleware.js';
import { createLogger, forInteraction } from '../core/logger.js';
import { MessageFlags } from 'discord.js';

export const name = 'interactionCreate';

export async function execute(interaction) {
  // Components (buttons/selects/modals) are handled by ComponentRouter
  if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) return;
  // Handle only slash commands here
  if (!interaction.isChatInputCommand()) return;

  if (interaction.client.isMaintenanceMode) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '🛠️ Bot is under maintenance. Try again later.', flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.followUp({ content: '🛠️ Bot is under maintenance. Try again later.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  const log = forInteraction(interaction);
  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    log.warn({ command: interaction.commandName }, 'Unknown command');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'This command is not available.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  // Middleware (cooldowns, perms, etc.)
  const res = await runMiddleware(interaction, command);
  if (!res.ok) return;

  // Telemetry
  const stats = interaction.client?.stats;
  if (stats?.commandExecs) {
    const n = stats.commandExecs.get(command.data.name) || 0;
    stats.commandExecs.set(command.data.name, n + 1);
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error({ err, command: interaction.commandName }, 'Command execute failed');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Error executing command.', ephemeral: true }).catch(() => {});
    }
    if (stats) stats.errors = (stats.errors || 0) + 1;
  }
}
