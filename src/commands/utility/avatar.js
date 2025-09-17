// src/commands/utility/avatar.js
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { safeReply } from '../../utils/moderation/mod.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'avatar' });

export default {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription("Get a user's avatar image.")
    .addUserOption(o => o
      .setName('user')
      .setDescription('The user to get the avatar of (defaults to yourself).')
      .setRequired(false))
    .addBooleanOption(o => o
      .setName('ephemeral')
      .setDescription('Whether the reply should be visible only to you (default: true).'))
    .setDMPermission(true),

  async execute(interaction) {
    try {
      // Get options, with defaults
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

      // Get the highest resolution dynamic avatar URL
      const avatarUrl = targetUser.displayAvatarURL({ dynamic: true, size: 1024 });

      // Generate links to other formats
      const links = ['PNG', 'JPG', 'WEBP', 'GIF'].map(ext => 
        `[${ext}](${targetUser.displayAvatarURL({ extension: ext.toLowerCase(), size: 1024 })})`
      ).join(' | ');

      const embed = new EmbedBuilder()
        .setTitle(`${targetUser.tag}'s Avatar`)
        .setColor(targetUser.accentColor || 0x5865F2) // Use user's accent color or a default
        .setImage(avatarUrl)
        .setDescription(`**Download Links:**\n${links}`);

      return safeReply(interaction, {
        embeds: [embed],
        ephemeral: ephemeral,
      });

    } catch (err) {
      log.error({ err }, 'Avatar command failed');
      return safeReply(interaction, {
        content: '❌ Could not retrieve avatar for this user.',
        status: 'error',
        ephemeral: true,
      });
    }
  },
};