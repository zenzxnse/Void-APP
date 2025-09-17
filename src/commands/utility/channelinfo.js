import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { createLogger } from '../../core/logger.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';

const log = createLogger({ mod: 'cmd:channelinfo' });

export default {
  data: new SlashCommandBuilder()
    .setName('channelinfo')
    .setDescription('Get detailed information about a channel')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to inspect')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildStageVoice,
          ChannelType.GuildForum,
          ChannelType.PublicThread,
          ChannelType.PrivateThread
        ))
    .addBooleanOption(option =>
      option.setName('ephemeral')
        .setDescription('Send response privately (default: true)')
    ),
  requiredBotPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
  guildOnly: true,

  async execute(interaction) {
    await ensureInGuild(interaction);

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    // caller access
    const callerCanView = channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel);
    if (!callerCanView) {
      return safeReply(interaction, {
        content: '❌ You do not have permission to view that channel.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        status: 'error',
      });
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle(`Channel Information: #${channel?.name ?? 'unknown'}`)
        .setColor(0x5865F2)
        .setTimestamp();

      // Basic
      embed.addFields(
        { name: 'ID', value: channel.id, inline: true },
        { name: 'Type', value: getChannelType(channel.type), inline: true },
        { name: 'Position', value: String(channel.position ?? 'N/A'), inline: true },
      );

      // Created (validated snowflake)
      const createdAt = safeSnowflakeDate(channel.id);
      embed.addFields({ name: 'Created', value: createdAt ? `<t:${Math.floor(createdAt.getTime() / 1000)}:R>` : 'Unknown', inline: true });

      // NSFW
      if ('nsfw' in channel) {
        embed.addFields({ name: 'NSFW', value: channel.nsfw ? '🔞 Yes' : '✅ No', inline: true });
      }

      // Slowmode
      if ('rateLimitPerUser' in channel) {
        const slowmode = channel.rateLimitPerUser;
        embed.addFields({ name: 'Slowmode', value: slowmode ? `${slowmode}s` : 'Disabled', inline: true });
      }

      // Topic
      if ('topic' in channel && channel.topic) {
        embed.addFields({ name: 'Topic', value: channel.topic.slice(0, 1024), inline: false });
      }

      // Category + inheritance (use permissionsLocked where supported)
      if (channel.parent) {
        embed.addFields(
          { name: 'Category', value: `${channel.parent.name} (${channel.parent.id})`, inline: true },
          { name: 'Inheriting Permissions', value: channel.permissionsLocked === true ? '✅ Yes' : '❌ No (custom overwrites)', inline: true },
        );
      }

      // Thread-specific
      if (typeof channel.isThread === 'function' && channel.isThread()) {
        embed.addFields(
          { name: 'Archived', value: channel.archived ? '✅ Yes' : '❌ No', inline: true },
          { name: 'Locked', value: channel.locked ? '🔒 Yes' : '🔓 No', inline: true },
          { name: 'Auto Archive', value: `${channel.autoArchiveDuration} minutes`, inline: true },
        );
        if (channel.parent) embed.addFields({ name: 'Parent Channel', value: `<#${channel.parent.id}>`, inline: true });
      }

      // Forum-specific
      if (channel.type === ChannelType.GuildForum) {
        embed.addFields({ name: 'Default Auto Archive', value: `${channel.defaultAutoArchiveDuration} minutes`, inline: true });
        if (Array.isArray(channel.availableTags) && channel.availableTags.length) {
          const tags = channel.availableTags.slice(0, 5).map(t => t.name).join(', ');
          embed.addFields({ name: 'Tags', value: tags + (channel.availableTags.length > 5 ? ', ...' : ''), inline: false });
        }
      }

      // Permission summary (@everyone + caller)
      const everyone = interaction.guild.roles.everyone;
      const everyonePerms = channel.permissionsFor(everyone) ?? { has: () => false };
      const callerPerms = channel.permissionsFor(interaction.member) ?? { has: () => false };

      const permChecks = [
        ['Send Messages', PermissionFlagsBits.SendMessages],
        ['Attach Files', PermissionFlagsBits.AttachFiles],
        ['Embed Links', PermissionFlagsBits.EmbedLinks],
        ['Add Reactions', PermissionFlagsBits.AddReactions],
        ['Use External Emojis', PermissionFlagsBits.UseExternalEmojis],
        ['Manage Messages', PermissionFlagsBits.ManageMessages],
        ['Manage Threads', PermissionFlagsBits.ManageThreads],
        ['Connect (Voice)', PermissionFlagsBits.Connect],
        ['Speak (Voice)', PermissionFlagsBits.Speak],
        ['Kick Members', PermissionFlagsBits.KickMembers],
      ];

      const everyonePermString =
        permChecks.filter(([, bit]) => everyonePerms.has(bit)).map(([name]) => name).join(', ') || 'None';
      const callerPermString =
        permChecks.filter(([, bit]) => callerPerms.has(bit)).map(([name]) => name).join(', ') || 'None';

      embed.addFields(
        { name: '@everyone Permissions', value: everyonePermString.slice(0, 1024), inline: false },
        { name: 'Your Permissions', value: callerPermString.slice(0, 1024), inline: false },
      );

      // Last activity (text-based only)
      if (typeof channel.isTextBased === 'function' && channel.isTextBased()) {
        try {
          // fetch a few in case latest is deleted
          const messages = await channel.messages.fetch({ limit: 5 }).catch(() => null);
          const last = messages?.first();
          if (last) embed.addFields({ name: 'Last Activity', value: `<t:${Math.floor(last.createdTimestamp / 1000)}:R>`, inline: true });
        } catch (err) {
          log.debug({ err, channelId: channel.id }, 'Could not fetch last message');
        }
      }

      await safeReply(interaction, {
        embeds: [embed],
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
      });

      // stats
      interaction.client.stats?.commandExecs?.set('channelinfo', (interaction.client.stats.commandExecs.get('channelinfo') || 0) + 1);
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'Failed to get channel info');
      await safeReply(interaction, { content: '❌ Failed to retrieve channel information.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
    }
  }
};

function getChannelType(type) {
  const types = {
    [ChannelType.GuildText]: '💬 Text',
    [ChannelType.GuildVoice]: '🔊 Voice',
    [ChannelType.GuildCategory]: '📁 Category',
    [ChannelType.GuildAnnouncement]: '📢 Announcement',
    [ChannelType.AnnouncementThread]: '📢 Announcement Thread',
    [ChannelType.PublicThread]: '🧵 Public Thread',
    [ChannelType.PrivateThread]: '🔒 Private Thread',
    [ChannelType.GuildStageVoice]: '🎭 Stage',
    [ChannelType.GuildForum]: '💬 Forum',
    [ChannelType.GuildMedia]: '🎬 Media',
  };
  return types[type] || 'Unknown';
}

function safeSnowflakeDate(id) {
  if (!/^\d{15,22}$/.test(String(id))) return null;
  try {
    const ms = Number((BigInt(id) >> 22n) + 1420070400000n);
    return new Date(ms);
  } catch { return null; }
}
