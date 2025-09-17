// src/commands/moderation/ban.js 
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import {
  ensureInGuild, normalizeReason, checkHierarchy,
  safeReply, emitModLog, humanizeError,
} from '../../utils/moderation/mod.js';
import { parseDurationSeconds, prettySecs } from '../../utils/moderation/duration.js';
import { createInfractionWithCount, logAudit, getGuildConfig } from '../../utils/moderation/mod-db.js'; 
import { enqueue } from '../../core/db/jobs.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'ban' });

export default {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server.')
    .addUserOption(o => o
      .setName('user')
      .setDescription('Member to ban')
      .setRequired(true))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Reason (shown in Audit Log)')
      .setMaxLength(512))
    .addStringOption(o => o
      .setName('duration')
      .setDescription('Duration for temp ban (e.g., 10s, 1h, 7d). Leave empty for permanent.')
      .setMaxLength(20))
    .addIntegerOption(o => o
      .setName('delete_days')
      .setDescription('Delete last N days of messages (0-7)')
      .setMinValue(0)
      .setMaxValue(7))
    .addBooleanOption(o => o
      .setName('silent')
      .setDescription('Suppress DM to the user'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),

  requiredBotPerms: [PermissionFlagsBits.BanMembers],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const user = interaction.options.getUser('user', true);
    const reason = normalizeReason(interaction.options.getString('reason'));
    const durationStr = interaction.options.getString('duration');
    const delDays = interaction.options.getInteger('delete_days') ?? 0;
    const silent = interaction.options.getBoolean('silent') ?? false;

    // Parse duration for temporary ban
    let durationSeconds = null;
    let isTemporary = false;
    
    if (durationStr) {
      durationSeconds = parseDurationSeconds(durationStr);
      
      if (!durationSeconds || durationSeconds <= 0) {
        return safeReply(interaction, { 
          content: '❌ Invalid duration format. Examples: `10s`, `1h`, `7d`, `30d`', 
          flags: MessageFlags.Ephemeral 
        });
      }
      
      // Minimum 10 seconds for testing, max 1 year
      const MIN_BAN_DURATION = 10; // 10 seconds minimum for testing
      const MAX_BAN_DURATION = 365 * 24 * 60 * 60; // 1 year
      
      if (durationSeconds < MIN_BAN_DURATION) {
        return safeReply(interaction, {
          content: `❌ Ban duration must be at least ${MIN_BAN_DURATION} seconds.`,
          flags: MessageFlags.Ephemeral
        });
      }
      
      if (durationSeconds > MAX_BAN_DURATION) {
        return safeReply(interaction, {
          content: '❌ Ban duration cannot exceed 1 year. Use permanent ban instead.',
          flags: MessageFlags.Ephemeral
        });
      }
      
      isTemporary = true;
    }

    // Fetch target member
    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    
    // Check if user is already banned
    const existingBan = await interaction.guild.bans.fetch(user.id).catch(() => null);
    if (existingBan) {
      return safeReply(interaction, { 
        content: '❌ That user is already banned.', 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    // If member exists in guild, check hierarchy
    if (target) {
      const hier = checkHierarchy({
        guild: interaction.guild,
        me: interaction.guild.members.me,
        actor: interaction.member,
        target,
      });
      
      if (!hier.ok) {
        return safeReply(interaction, { 
          content: humanizeError(hier.why), 
          flags: MessageFlags.Ephemeral 
        });
      }
    }

    try {
      // Try to DM the user before banning (if they're in the server and not silent)
      const { dm_on_action: dmOnAction } = await getGuildConfig(interaction.guildId, 'dm_on_action');
      let dmFailed = false;
      
      if (!silent && dmOnAction && target) {
        try {
          const banMessage = isTemporary
            ? `⛔ **You have been temporarily banned from ${interaction.guild.name}**\n` +
              `⏱️ **Duration:** ${prettySecs(durationSeconds)}\n` +
              `📅 **Expires:** <t:${Math.floor((Date.now() + durationSeconds * 1000) / 1000)}:F>\n` +
              `${reason ? `📝 **Reason:** ${reason}` : ''}`
            : `⛔ **You have been permanently banned from ${interaction.guild.name}**\n` +
              `${reason ? `📝 **Reason:** ${reason}` : ''}`;
          const banEmbed = new EmbedBuilder()
            .setTitle(isTemporary ? 'Temporary Ban' : 'Permanent Ban')
            .setDescription(banMessage)
            .setFooter({ text: `Banned by ${interaction.user.tag}` });

          await target.send({ embeds: [banEmbed] });
        } catch (err) {
          dmFailed = true;
          log.debug({ userId: user.id, error: err.message }, 'Could not DM user before ban');
        }
      }

      // Create infraction record
      // NOTE: duration_seconds can be null for permanent bans (constraint fixed in schema)
      const infraction = await createInfractionWithCount({
        guildId: interaction.guildId,
        userId: user.id,
        moderatorId: interaction.user.id,
        type: 'ban',
        reason: reason || 'No reason provided',
        durationSeconds: durationSeconds, // null for permanent bans
      });

      // Execute the ban
      await interaction.guild.members.ban(user, {
        reason: `[${interaction.user.tag}] ${reason || 'No reason provided'}${isTemporary ? ` (Temp: ${prettySecs(durationSeconds)})` : ''}`,
        deleteMessageSeconds: delDays * 86400,
      });

      // Schedule unban if temporary
      if (isTemporary) {
        const unbanAt = new Date(Date.now() + durationSeconds * 1000);
        
        const job = await enqueue({
          type: 'unban',
          guild_id: interaction.guildId,
          user_id: user.id,
          infraction_id: infraction.id,
          run_at: unbanAt,
          priority: 60, // Higher priority for unbans
          data: {
            bannedBy: interaction.user.id,
            reason: reason,
            duration: durationSeconds
          }
        });

        log.info({ 
          jobId: job.id, 
          userId: user.id,
          unbanAt: unbanAt.toISOString() 
        }, 'Scheduled unban job');
      }

      // Log to mod log
      await emitModLog(interaction, {
        action: 'ban',
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetId: user.id,
        reason,
        delDays,
        ts: Date.now(),
        caseId: infraction.id,
        temporary: isTemporary,
        duration: durationSeconds,
        dmFailed,
      });

      // Audit log
      await logAudit({
        guildId: interaction.guildId,
        actionType: 'ban',
        actorId: interaction.user.id,
        targetId: user.id,
        details: { 
          reason, 
          caseId: infraction.id,
          deleteMessageDays: delDays,
          temporary: isTemporary,
          durationSeconds,
          dmFailed,
        },
      });

      // Build response
      const response = isTemporary
        ? [
            `✅ **Temporarily banned ${target?.user.tag || user.tag}**`,
            `⏱️ **Duration:** ${prettySecs(durationSeconds)}`,
            `📅 **Expires:** <t:${Math.floor((Date.now() + durationSeconds * 1000) / 1000)}:R>`,
            `📋 **Case ID:** \`${infraction.id}\``,
            reason ? `📝 **Reason:** ${reason}` : null,
            delDays ? `🗑️ **Deleted:** ${delDays} days of messages` : null,
            dmFailed ? '⚠️ *Could not DM user*' : null,
          ].filter(Boolean).join('\n')
        : [
            `✅ **Permanently banned ${target?.user.tag || user.tag}**`,
            `📋 **Case ID:** \`${infraction.id}\``,
            reason ? `📝 **Reason:** ${reason}` : null,
            delDays ? `🗑️ **Deleted:** ${delDays} days of messages` : null,
            dmFailed ? '⚠️ *Could not DM user*' : null,
          ].filter(Boolean).join('\n');

      return safeReply(interaction, {
        content: response,
        flags: MessageFlags.Ephemeral,
      });
      
    } catch (err) {
      log.error({ err, userId: user.id }, 'Ban command error');
      
      // Check for specific Discord API errors
      if (err.code === 50013) {
        return safeReply(interaction, {
          content: '❌ I lack permissions to ban that user. They may have a higher role than me.',
          flags: MessageFlags.Ephemeral
        });
      }
      
      return safeReply(interaction, {
        content: '❌ Failed to ban user. Please check my permissions and try again.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};