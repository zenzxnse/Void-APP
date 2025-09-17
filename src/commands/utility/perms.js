import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { createLogger } from '../../core/logger.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';

const log = createLogger({ mod: 'cmd:perms' });

// base bits; 'send' handled dynamically for threads
const ACTION_BITS = {
  send: [PermissionFlagsBits.SendMessages],
  attach: [PermissionFlagsBits.AttachFiles],
  embed: [PermissionFlagsBits.EmbedLinks],
  react: [PermissionFlagsBits.AddReactions],
  manage: [PermissionFlagsBits.ManageMessages],
  timeout: [PermissionFlagsBits.ModerateMembers],
  ban: [PermissionFlagsBits.BanMembers],
  kick: [PermissionFlagsBits.KickMembers],
  voice: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
};

export default {
  data: new SlashCommandBuilder()
    .setName('perms')
    .setDescription('Check if a user can perform specific actions')
    .addUserOption(o => o.setName('user').setDescription('The user to check permissions for').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('The channel to check permissions in'))
    .addStringOption(o =>
      o.setName('action').setDescription('Specific action to check').addChoices(
        { name: 'Send Messages', value: 'send' },
        { name: 'Attach Files', value: 'attach' },
        { name: 'Embed Links', value: 'embed' },
        { name: 'Add Reactions', value: 'react' },
        { name: 'Manage Messages', value: 'manage' },
        { name: 'Timeout Members', value: 'timeout' },
        { name: 'Ban Members', value: 'ban' },
        { name: 'Kick Members', value: 'kick' },
        { name: 'Voice (Connect & Speak)', value: 'voice' },
      ),
    )
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Send response privately (default: true)')),
  guildOnly: true,

  async execute(interaction) {
    await ensureInGuild(interaction);

    const member = interaction.options.getMember('user');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const action = interaction.options.getString('action');
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    const canCheckOthers = interaction.member.id === member?.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!canCheckOthers) {
      return safeReply(interaction, {
        content: '❌ You can only check your own permissions. Use `/can` instead.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        status: 'warn',
      });
    }
    if (!member) {
      return safeReply(interaction, { content: '❌ User not found in this server.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle('Permission Check')
        .setColor(0x5865F2)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setDescription(`**User:** ${member} (${member.user.tag})\n**Channel:** <#${channel.id}> (#${channel.name})`);

      if (action) {
        let bits = ACTION_BITS[action] || [];
        if (action === 'send' && channel.isThread?.()) bits = [PermissionFlagsBits.SendMessagesInThreads];

        const perms = channel.permissionsFor(member) ?? { has: () => false };
        const hasPermission = bits.every(bit => perms.has(bit));
        embed.addFields({ name: `Can ${action}?`, value: hasPermission ? '✅ Yes' : '❌ No', inline: false });

        if (!hasPermission) {
          const missing = bits.filter(bit => !perms.has(bit));
          const missingNames = missing.map(bit => Object.entries(PermissionFlagsBits).find(([, v]) => v === bit)?.[0] || 'Unknown');
          embed.addFields({ name: 'Missing Permissions', value: missingNames.join(', '), inline: false });

          // explicit denies: member + roles on the channel (inheritance note)
          const overwrites = channel.permissionOverwrites?.cache;
          const denies = [];

          const memberOverwrite = overwrites?.get(member.id);
          if (memberOverwrite) {
            const denied = bits.filter(bit => memberOverwrite.deny.has(bit));
            if (denied.length) denies.push(`User-specific overwrite denies: ${denied.length}`);
          }
          for (const role of member.roles.cache.values()) {
            const roleOverwrite = overwrites?.get(role.id);
            if (roleOverwrite) {
              const denied = bits.filter(bit => roleOverwrite.deny.has(bit));
              if (denied.length) denies.push(`Role ${role} denies: ${denied.length}`);
            }
          }
          if (denies.length) {
            embed.addFields({ name: 'Explicit Denies (Channel)', value: denies.slice(0, 3).join('\n') + (denies.length > 3 ? '\n...' : ''), inline: false });
          }
          if (channel.parent && channel.permissionsLocked !== true) {
            embed.addFields({ name: 'Category Inheritance', value: 'This channel has custom overwrites (not fully inherited).', inline: false });
          }
        }
      } else {
        const perms = channel.permissionsFor(member) ?? { has: () => false };
        const lines = [];
        for (const [actionName, baseBits] of Object.entries(ACTION_BITS)) {
          const bits = actionName === 'send' && channel.isThread?.() ? [PermissionFlagsBits.SendMessagesInThreads] : baseBits;
          const ok = bits.every(bit => perms.has(bit));
          lines.push(`${ok ? '✅' : '❌'} **${actionName}**`);
        }
        embed.addFields({ name: 'Permission Matrix', value: lines.join('\n'), inline: false });

        if (perms.has(PermissionFlagsBits.Administrator)) {
          embed.addFields({ name: '⚠️ Administrator', value: 'User has Administrator which bypasses checks.', inline: false });
        }
      }

      const highestRole = member.roles.highest;
      embed.addFields({ name: 'Highest Role', value: `${highestRole} (Position: ${highestRole.position})`, inline: true });

      if (channel.parent) {
        const synced = channel.permissionsLocked === true;
        embed.addFields({ name: 'Category Sync', value: synced ? '✅ Synced with category' : '⚠️ Custom permissions', inline: true });
      }

      await safeReply(interaction, { embeds: [embed], flags: ephemeral ? MessageFlags.Ephemeral : undefined });
      interaction.client.stats?.commandExecs?.set('perms', (interaction.client.stats.commandExecs.get('perms') || 0) + 1);
    } catch (err) {
      log.error({ err, userId: member.id, channelId: channel.id }, 'Failed to check permissions');
      await safeReply(interaction, { content: '❌ Failed to check permissions.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
    }
  },
};

// /can alias
export const canCommand = {
  data: new SlashCommandBuilder()
    .setName('can')
    .setDescription('Check if you can perform specific actions')
    .addStringOption(o =>
      o.setName('action')
        .setDescription('Action to check')
        .setRequired(true)
        .addChoices(
          { name: 'Send Messages', value: 'send' },
          { name: 'Attach Files', value: 'attach' },
          { name: 'Embed Links', value: 'embed' },
          { name: 'Add Reactions', value: 'react' },
          { name: 'Manage Messages', value: 'manage' },
          { name: 'Timeout Members', value: 'timeout' },
          { name: 'Ban Members', value: 'ban' },
          { name: 'Kick Members', value: 'kick' },
          { name: 'Voice (Connect & Speak)', value: 'voice' },
        ),
    )
    .addChannelOption(o => o.setName('channel').setDescription('The channel to check permissions in'))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Send response privately (default: true)')),
  guildOnly: true,

  async execute(interaction) {
    await ensureInGuild(interaction);

    const action = interaction.options.getString('action', true);
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    let bits = ACTION_BITS[action] || [];
    if (action === 'send' && channel.isThread?.()) bits = [PermissionFlagsBits.SendMessagesInThreads];

    const perms = channel.permissionsFor(interaction.member) ?? { has: () => false };
    const ok = bits.every(bit => perms.has(bit));

    const embed = new EmbedBuilder()
      .setTitle(`Can you ${action}?`)
      .setColor(ok ? 0x00ff00 : 0xff0000)
      .setDescription(`**Channel:** <#${channel.id}>\n**Result:** ${ok ? '✅ Yes' : '❌ No'}`)
      .setTimestamp();

    if (!ok) {
      const missing = bits.filter(bit => !perms.has(bit));
      const missingNames = missing.map(bit => Object.entries(PermissionFlagsBits).find(([, v]) => v === bit)?.[0] || 'Unknown');
      embed.addFields({ name: 'Missing Permissions', value: missingNames.join(', '), inline: false });
    }

    await safeReply(interaction, { embeds: [embed], flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    interaction.client.stats?.commandExecs?.set('can', (interaction.client.stats.commandExecs.get('can') || 0) + 1);
  },
};
