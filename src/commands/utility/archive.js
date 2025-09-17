import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
  AttachmentBuilder,
} from 'discord.js';
import { createLogger } from '../../core/logger.js';
import { query } from '../../core/db/index.js';
import RateLimiter from '../../utils/rateLimiter.js';
import { ensureInGuild, safeReply, canPurgeChannel } from '../../utils/moderation/mod.js';
import * as modHelpers from '../../utils/moderation/mod.js';

const log = createLogger({ mod: 'cmd:archive' });

export default {
  data: new SlashCommandBuilder()
    .setName('archive')
    .setDescription('Export channel messages and archive the channel')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel to archive')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread))
    .addIntegerOption(o =>
      o.setName('limit')
        .setDescription('Number of messages to export (default: 500, max: 2000)')
        .setMinValue(1)
        .setMaxValue(2000))
    .addStringOption(o =>
      o.setName('to')
        .setDescription('Where to send the export')
        .addChoices({ name: 'File (attach here)', value: 'file' }, { name: 'DM', value: 'dm' }))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Send response privately (default: true)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  requiredPerms: [PermissionFlagsBits.ManageChannels],
  requiredBotPerms: [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageThreads,
  ],
  guildOnly: true,

  async execute(interaction) {
    await ensureInGuild(interaction);

    const channel = interaction.options.getChannel('channel');
    const limit = interaction.options.getInteger('limit') || 500;
    let exportTo = interaction.options.getString('to') || 'file';
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    // caller permission in target channel
    const callerOK = channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ManageChannels);
    if (!callerOK) {
      return safeReply(interaction, {
        content: '❌ You need Manage Channels permission for that channel.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        status: 'error',
      });
    }
    const botOK = channel.permissionsFor(interaction.guild.members.me);
    if (!botOK?.has(PermissionFlagsBits.ViewChannel) || !botOK.has(PermissionFlagsBits.ReadMessageHistory)) {
      return safeReply(interaction, {
        content: '❌ I need View Channel & Read Message History in that channel.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        status: 'error',
      });
    }

    const startTime = Date.now();
    const limiter = new RateLimiter();

    try {
      await safeReply(interaction, {
        content: `⏳ Exporting up to **${limit}** messages from <#${channel.id}>…`,
        flags: MessageFlags.Ephemeral,
        status: 'info',
        fetchReply: false,
      });

      // Step 1: Export messages
      const messages = await fetchMessages(channel, limit, limiter);

      if (messages.length === 0) {
        return safeReply(interaction, { content: '⚠️ No messages found in that channel.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'warn' });
      }

      const exportData = {
        guild: { id: interaction.guild.id, name: interaction.guild.name },
        channel: {
          id: channel.id,
          name: channel.name,
          type: getTypeName(channel.type),
          parent: channel.parent ? { id: channel.parent.id, name: channel.parent.name } : null,
        },
        exported_at: new Date().toISOString(),
        exported_by: { id: interaction.user.id, tag: interaction.user.tag },
        message_count: messages.length,
        messages: messages.map(msg => ({
          id: msg.id,
          author_id: msg.author?.id || 'unknown',
          author_tag: msg.author?.tag || 'Unknown User',
          author_bot: Boolean(msg.author?.bot),
          created_at: new Date(msg.createdTimestamp).toISOString(),
          edited_at: msg.editedTimestamp ? new Date(msg.editedTimestamp).toISOString() : null,
          content: msg.content || null,
          attachments: [...msg.attachments.values()].map(a => ({
            name: a.name,
            size: a.size,
            url: a.url,
            content_type: a.contentType,
          })),
          embeds_count: msg.embeds?.length || 0,
          reactions: [...msg.reactions.cache.values()].map(r => ({ emoji: r.emoji.toString(), count: r.count })),
          pinned: Boolean(msg.pinned),
          reference: msg.reference ? { message_id: msg.reference.messageId, channel_id: msg.reference.channelId } : null,
        })),
      };

      const jsonBuf = Buffer.from(JSON.stringify(exportData, null, 2), 'utf8');
      const csvBuf = Buffer.from(createCSV(exportData.messages), 'utf8');
      const jsonFile = new AttachmentBuilder(jsonBuf, { name: `archive_${channel.name}_${Date.now()}.json` });
      const csvFile = new AttachmentBuilder(csvBuf, { name: `archive_${channel.name}_${Date.now()}.csv` });

      // Step 2: Send export
      const totalSize = jsonBuf.length + csvBuf.length;

      if (exportTo === 'dm' && totalSize < 8 * 1024 * 1024) {
        try {
          if (typeof modHelpers.tryDm === 'function') {
            await modHelpers.tryDm(interaction.user, {
              content: `📦 Archive of **#${channel.name}** from **${interaction.guild.name}**`,
              files: [jsonFile, csvFile],
            });
          } else {
            await interaction.user.send({ content: `📦 Archive of **#${channel.name}** from **${interaction.guild.name}**`, files: [jsonFile, csvFile] });
          }
          await safeReply(interaction, { content: '✅ Archive sent to your DMs!', flags: MessageFlags.Ephemeral, status: 'success' });
        } catch (err) {
          log.warn({ err }, 'Could not DM archive, falling back to channel');
          exportTo = 'file';
        }
      }

      if (exportTo === 'file') {
        await safeReply(interaction, {
          content: `✅ Exported ${messages.length} messages from <#${channel.id}>`,
          files: [jsonFile, csvFile],
          flags: MessageFlags.Ephemeral,
          status: 'success',
          fetchReply: false,
        });
        // auto-delete after 60s for privacy
        setTimeout(async () => { try { await interaction.deleteReply(); } catch {} }, 60_000);
      }

      // Step 3: Archive the channel
      const archiveResult = await archiveChannel(channel, interaction.guild, limiter);

      // TODO (optional): cancel channel-scoped scheduled jobs (slowmode_end/lockdown_end) if you store them; pseudo:
      // await query('delete from scheduled_jobs where channel_id = $1 and type in ($2,$3)', [channel.id, 'slowmode_end', 'lockdown_end']);

      // Step 4: Audit log
      await query(
        `insert into audit_logs (guild_id, action_type, actor_id, target_id, details, timestamp)
         values ($1,$2,$3,$4,$5, now())`,
        [
          interaction.guildId,
          'channel_archive',
          interaction.user.id,
          channel.id,
          JSON.stringify({
            channel_name: channel.name,
            messages_exported: messages.length,
            archive_category: archiveResult.categoryName,
            duration_ms: Date.now() - startTime,
          }),
        ],
      );

      const statusEmbed = new EmbedBuilder()
        .setTitle('✅ Channel Archived')
        .setColor(0x00ff00)
        .setDescription(
          `**Channel:** #${channel.name}\n` +
          `**Messages Exported:** ${messages.length}\n` +
          `**Archive Location:** ${archiveResult.categoryName}\n` +
          `**Status:** ${archiveResult.status}`,
        )
        .setTimestamp();

      await safeReply(interaction, { embeds: [statusEmbed], flags: MessageFlags.Ephemeral, fetchReply: false });
      interaction.client.stats?.commandExecs?.set('archive', (interaction.client.stats.commandExecs.get('archive') || 0) + 1);
    } catch (err) {
      log.error({ err, channelId: channel.id }, 'Failed to archive channel');
      await safeReply(interaction, { content: '❌ Failed to archive channel. Check my permissions and try again.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
    }
  },
};

async function fetchMessages(channel, limit, limiter) {
  const out = [];
  let before;
  const step = 100;

  while (out.length < limit) {
    const page = await channel.messages.fetch({ limit: Math.min(step, limit - out.length), before }).catch(() => null);
    if (!page || page.size === 0) break;

    out.push(...page.values());
    before = page.last().id;

    if (out.length < limit && page.size === step) {
      await limiter.wait();
    }
  }

  return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function archiveChannel(channel, guild, limiter) {
  const res = { categoryName: 'Archive', status: 'unknown' };

  try {
    if (channel.isThread?.()) {
      await channel.setLocked(true, 'Channel archived');
      await limiter.wait();
      await channel.setArchived(true, 'Channel archived');
      res.status = 'Thread locked and archived';
      return res;
    }

    let archiveCategory = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'Archive');
    if (!archiveCategory) {
      archiveCategory = await guild.channels.create({
        name: 'Archive',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads], allow: [PermissionFlagsBits.ViewChannel] },
        ],
        reason: 'Created archive category',
      });
      await limiter.wait();
    }

    res.categoryName = archiveCategory.name;

    await channel.setParent(archiveCategory.id, { lockPermissions: false, reason: 'Channel archived' });
    await limiter.wait();

    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: false, SendMessagesInThreads: false },
      { reason: 'Channel archived' },
    );

    res.status = 'Channel moved to archive and locked';
  } catch (err) {
    log.error({ err, channelId: channel.id }, 'Error archiving channel');
    res.status = 'Failed to fully archive (check permissions)';
  }

  return res;
}

function csvEscape(v) {
  const s = String(v ?? '');
  // Escape quotes by doubling, wrap in quotes; also normalize newlines
  const q = `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  return q;
}

function createCSV(messages) {
  const headers = ['ID', 'Author', 'Date', 'Content (truncated)', 'Attachments', 'Reactions'];
  const rows = [headers.join(',')];

  for (const msg of messages) {
    const content = (msg.content || '').slice(0, 1000);
    const attCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
    const reactStr = Array.isArray(msg.reactions) ? msg.reactions.map(r => `${r.emoji}x${r.count}`).join(' ') : '';

    rows.push([
      csvEscape(msg.id),
      csvEscape(msg.author_tag),
      csvEscape(msg.created_at),
      csvEscape(content),
      csvEscape(attCount),
      csvEscape(reactStr),
    ].join(','));
  }

  return rows.join('\n');
}

function getTypeName(type) {
  const map = {
    [ChannelType.GuildText]: 'Text Channel',
    [ChannelType.PublicThread]: 'Public Thread',
    [ChannelType.PrivateThread]: 'Private Thread',
    [ChannelType.GuildAnnouncement]: 'Announcement Channel',
  };
  return map[type] || 'Unknown';
}
