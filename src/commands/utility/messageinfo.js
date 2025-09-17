import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { createLogger } from '../../core/logger.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';

const log = createLogger({ mod: 'cmd:messageinfo' });

export default {
  data: new SlashCommandBuilder()
    .setName('messageinfo')
    .setDescription('Get detailed information about a message')
    .addStringOption(o => o.setName('link').setDescription('Discord message link').setRequired(true))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Send response privately (default: true)')),
  requiredBotPerms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
  guildOnly: true,

  async execute(interaction) {
    await ensureInGuild(interaction);

    const link = interaction.options.getString('link', true);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    const parsed = parseMessageLink(link);
    if (!parsed) {
      return safeReply(interaction, {
        content: '❌ Invalid message link. Provide a valid Discord message URL.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        status: 'error',
      });
    }

    const { guildId, channelId, messageId } = parsed;

    if (guildId !== interaction.guildId) {
      return safeReply(interaction, {
        content: '❌ Cannot fetch messages from other servers.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        status: 'error',
      });
    }

    try {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        return safeReply(interaction, { content: '❌ Channel not found or no longer exists.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
      }

      const callerCanView = channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel);
      if (!callerCanView) return safeReply(interaction, { content: '❌ You do not have permission to view that channel.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms.has(PermissionFlagsBits.ReadMessageHistory)) {
        return safeReply(interaction, { content: '❌ I need View Channel & Read Message History in that channel.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
      }

      let message = channel.messages.cache.get(messageId);
      if (!message) {
        message = await channel.messages.fetch(messageId).catch(err => (err?.code === 10008 ? null : Promise.reject(err)));
      }
      if (!message) {
        return safeReply(interaction, { content: '❌ Message not found. It may have been deleted.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'warn' });
      }

      const embed = new EmbedBuilder().setColor(0x5865F2).setTimestamp(message.createdTimestamp);

      if (message.author) {
        embed.setAuthor({
          name: `${message.author.tag} (${message.author.id})`,
          iconURL: message.author.displayAvatarURL({ dynamic: true }),
        }).addFields({ name: 'Author', value: message.author.bot ? `🤖 Bot: <@${message.author.id}>` : `<@${message.author.id}>`, inline: true });
      } else if (message.webhookId) {
        embed.setAuthor({ name: `Webhook (${message.webhookId})` });
      }

      embed.addFields(
        { name: 'Message ID', value: message.id, inline: true },
        { name: 'Channel', value: `<#${channel.id}>`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, inline: true },
      );

      if (message.editedTimestamp) {
        embed.addFields({ name: 'Edited', value: `<t:${Math.floor(message.editedTimestamp / 1000)}:F>`, inline: true });
      }

      if (message.content?.length) {
        embed.addFields({ name: 'Content Length', value: `${message.content.length} characters`, inline: true });
      }

      if (message.embeds?.length) {
        embed.addFields({ name: 'Embeds', value: `${message.embeds.length} embed(s)`, inline: true });
      }

      if (message.attachments?.size) {
        const all = [...message.attachments.values()];
        const shown = all.slice(0, 5).map(a => `• ${a.name} (${formatBytes(a.size)})`).join('\n');
        const suffix = all.length > 5 ? `\n… and ${all.length - 5} more` : '';
        embed.addFields({ name: `Attachments (${all.length})`, value: shown + suffix, inline: false });
      }

      if (message.reactions?.cache?.size) {
        const all = [...message.reactions.cache.values()];
        const shown = all.slice(0, 10).map(r => `${r.emoji} × ${r.count}`).join(' ');
        const suffix = all.length > 10 ? ` …(+${all.length - 10})` : '';
        embed.addFields({ name: 'Reactions', value: shown + suffix, inline: false });
      }

      const flags = [];
      if (message.pinned) flags.push('📌 Pinned');
      if (message.tts) flags.push('🔊 TTS');
      if (message.mentions?.everyone) flags.push('@everyone');
      if (message.crosspostable) flags.push('📰 Crosspostable');
      if (flags.length) embed.addFields({ name: 'Flags', value: flags.join(', '), inline: false });

      if (message.hasThread && message.thread) {
        embed.addFields({ name: 'Thread', value: `<#${message.thread.id}> (${message.thread.memberCount || 0} members)`, inline: true });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Jump to Message').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guildId}/${channelId}/${messageId}`).setEmoji('🔗'),
      );

      await safeReply(interaction, {
        embeds: [embed],
        components: [row],
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
      });

      interaction.client.stats?.commandExecs?.set('messageinfo', (interaction.client.stats.commandExecs.get('messageinfo') || 0) + 1);
    } catch (err) {
      log.error({ err, link }, 'Failed to get message info');
      const msg = err?.code === 50001 ? '❌ Missing access to that channel.'
        : err?.code === 50013 ? '❌ Missing permissions to read that channel.'
        : '❌ Failed to retrieve message information.';
      await safeReply(interaction, { content: msg, flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
    }
  }
};

function parseMessageLink(url) {
  const patterns = [
    /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/,
    /(?:ptb|canary)\.discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m) return { guildId: m[1], channelId: m[2], messageId: m[3] };
  }
  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}
