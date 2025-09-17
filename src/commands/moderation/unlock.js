// src/commands/moderation/unlock.js - FIXED VERSION
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { tx } from '../../core/db/index.js';
import { logAudit } from '../../utils/moderation/mod-db.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'unlock' });

export default {
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock a channel (restore sending messages for @everyone)')
    .addChannelOption(o => o
      .setName('channel')
      .setDescription('Channel to unlock (default: current channel)')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread
      ))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Reason for unlocking')
      .setMaxLength(256))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  requiredBotPerms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageThreads],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const reason = interaction.options.getString('reason')?.trim() || 'Manual unlock';

    // Validate channel type
    if (!channel.isTextBased() || channel.isDMBased()) {
      return safeReply(interaction, {
        content: '❌ This command can only be used on text channels.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Check for thread-specific issues
    if (channel.isThread()) {
      if (channel.archived) {
        return safeReply(interaction, {
          content: '❌ Cannot unlock an archived thread. Unarchive it first.',
          flags: MessageFlags.Ephemeral
        });
      }
      if (!channel.locked) {
        return safeReply(interaction, {
          content: '❌ This thread is not locked.',
          flags: MessageFlags.Ephemeral
        });
      }
      // For threads, unlock the thread itself
      try {
        await channel.setLocked(false, `[${interaction.user.tag}] ${reason}`);
      } catch (err) {
        log.error({ err, channelId: channel.id }, 'Failed to unlock thread');
        return safeReply(interaction, {
          content: '❌ Failed to unlock thread. Check my permissions.',
          flags: MessageFlags.Ephemeral
        });
      }
    } else {
      // For regular channels, check if actually locked
      const everyone = interaction.guild.roles.everyone;
      const currentPerms = channel.permissionOverwrites.cache.get(everyone.id);
      const isLocked = currentPerms?.deny?.has(PermissionFlagsBits.SendMessages);

      if (!isLocked) {
        return safeReply(interaction, {
          content: '❌ This channel is not locked.',
          flags: MessageFlags.Ephemeral
        });
      }

      // Check if there are role-specific overwrites that might still block
      const categoryPerms = channel.parent?.permissionOverwrites.cache.get(everyone.id);
      const categoryDenies = categoryPerms?.deny?.has(PermissionFlagsBits.SendMessages);
      
      if (categoryDenies) {
        log.warn({ 
          channelId: channel.id, 
          categoryId: channel.parentId 
        }, 'Category has SendMessages denied, channel unlock may not be fully effective');
      }
    }

    try {
      // Unlock the channel (for non-threads)
      if (!channel.isThread()) {
        const everyone = interaction.guild.roles.everyone;
        await channel.permissionOverwrites.edit(everyone, {
          SendMessages: null,
          SendMessagesInThreads: null,
          CreatePublicThreads: null,
          CreatePrivateThreads: null,
        }, {
          reason: `[${interaction.user.tag}] ${reason.substring(0, 400)}`
        });
      }

      // Use transaction for database operations
      const cancelledJobs = await tx(async (client) => {
        // Update channel config
        await client.query(
          `UPDATE channel_config 
           SET lockdown_enabled = FALSE, updated_at = NOW()
           WHERE channel_id = $1`,
          [channel.id]
        );

        // Cancel pending unlock jobs
        const { rows } = await client.query(
          `DELETE FROM scheduled_jobs 
           WHERE type = 'lockdown_end' 
             AND channel_id = $1 
             AND run_at > NOW()
           RETURNING id, data`,
          [channel.id]
        );

        return rows;
      });

      if (cancelledJobs.length > 0) {
        log.info({ 
          channelId: channel.id, 
          cancelled: cancelledJobs.map(j => j.id) 
        }, 'Cancelled pending unlock jobs');
      }

      // Send notification to channel
      try {
        await channel.send({
          content: `🔓 **Channel unlocked by ${interaction.user}**\n📝 Reason: ${reason}`
        });
      } catch (err) {
        log.debug({ err }, 'Could not send unlock notification to channel');
      }

      // Log to audit
      await logAudit({
        guildId: interaction.guildId,
        actionType: 'channel_unlock',
        actorId: interaction.user.id,
        targetId: channel.id,
        details: {
          channelName: channel.name,
          channelType: channel.type,
          reason,
          cancelledJobs: cancelledJobs.length,
          jobIds: cancelledJobs.map(j => j.id)
        }
      });

      // Check category inheritance warning
      const categoryWarning = channel.parent?.permissionOverwrites.cache.get(interaction.guild.roles.everyone.id)
        ?.deny?.has(PermissionFlagsBits.SendMessages) 
        ? '\n⚠️ Note: Category may still restrict sending messages' 
        : '';

      return safeReply(interaction, {
        content: `✅ **Unlocked ${channel}**${cancelledJobs.length > 0 ? `\n⚠️ Cancelled ${cancelledJobs.length} automatic unlock${cancelledJobs.length > 1 ? 's' : ''}` : ''}${categoryWarning}`,
        flags: MessageFlags.Ephemeral
      });

    } catch (err) {
      log.error({ err, channelId: channel.id }, 'Failed to unlock channel');
      return safeReply(interaction, {
        content: '❌ Failed to unlock channel. Please check my permissions.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};