// src/commands/moderation/selfban.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import {
  ensureInGuild,
  normalizeReason,
  safeReply,
  emitModLog,
  humanizeError,
} from '../../utils/moderation/mod.js';
import { parseDurationSeconds, prettySecs } from '../../utils/moderation/duration.js';
import { createInfractionWithCount, logAudit, getGuildConfig } from '../../utils/moderation/mod-db.js';
import { enqueue } from '../../core/db/jobs.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'selfban' });

/**
 * Self-ban allows members to ban themselves for a limited time.
 * Safety rails:
 *  - Requires duration (no default permanent).
 *  - Blocks server owner.
 *  - Verifies the bot can ban the actor (role position / permission).
 *  - Optional DM unless 'silent'.
 */
export default {
  data: new SlashCommandBuilder()
    .setName('selfban')
    .setDescription('Ban yourself from this server for a limited duration.')
    .addStringOption(o => o
      .setName('duration')
      .setDescription('How long? e.g., 10s, 30m, 2h, 7d, 30d (min 10s, max 1y)')
      .setRequired(true)
      .setMaxLength(20))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Optional reason (shown in Audit Log)')
      .setMaxLength(512))
    .addIntegerOption(o => o
      .setName('delete_days')
      .setDescription('Delete last N days of your messages (0-7). Default 0.')
      .setMinValue(0)
      .setMaxValue(7))
    .addBooleanOption(o => o
      .setName('silent')
      .setDescription('Do not DM me about this ban'))
    .setDMPermission(false),

  // Bot must be able to ban members
  requiredBotPerms: [PermissionFlagsBits.BanMembers],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const actorUser = interaction.user;
    const reason = normalizeReason(interaction.options.getString('reason'));
    const durationStr = interaction.options.getString('duration', true);
    const delDays = interaction.options.getInteger('delete_days') ?? 0;
    const silent = interaction.options.getBoolean('silent') ?? false;

    // Duration parse & guardrails
    const MIN_BAN_DURATION = 10; // 10 seconds
    const MAX_BAN_DURATION = 365 * 24 * 60 * 60; // 1 year

    const durationSeconds = parseDurationSeconds(durationStr);
    if (!durationSeconds || durationSeconds <= 0) {
      return safeReply(interaction, {
        content: '❌ Invalid duration format. Examples: `10s`, `30m`, `2h`, `7d`, `30d`',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationSeconds < MIN_BAN_DURATION) {
      return safeReply(interaction, {
        content: `❌ Duration must be at least ${MIN_BAN_DURATION} seconds.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationSeconds > MAX_BAN_DURATION) {
      return safeReply(interaction, {
        content: '❌ Duration cannot exceed 1 year.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Fetch member & basic guards
    const guild = interaction.guild;
    const me = guild.members.me;
    const actor = await guild.members.fetch(actorUser.id).catch(() => null);

    if (!actor) {
      return safeReply(interaction, {
        content: humanizeError('NoTarget'), // “Target not found.”
        flags: MessageFlags.Ephemeral,
      });
    }
    if (actor.id === guild.ownerId) {
      return safeReply(interaction, {
        content: '❌ You are the server owner and cannot self-ban.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Ensure bot can act on the actor (role position & permission)
    const botPos = me?.roles?.highest?.position ?? 0;
    const actorPos = actor?.roles?.highest?.position ?? 0;
    if (botPos <= actorPos) {
      return safeReply(interaction, {
        content: humanizeError('BotBelowTarget'), // “I can’t act on that member due to role hierarchy.”
        flags: MessageFlags.Ephemeral,
      });
    }

    // Already banned?
    const existingBan = await guild.bans.fetch(actorUser.id).catch(() => null);
    if (existingBan) {
      return safeReply(interaction, {
        content: '❌ You are already banned.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      // DM (optional)
      const { dm_on_action: dmOnAction } = await getGuildConfig(guild.id, 'dm_on_action');
      let dmFailed = false;
      if (!silent && dmOnAction) {
        try {
          const emb = new EmbedBuilder()
            .setTitle('⛔ Self Ban Requested')
            .setDescription(
              [
                `You requested a temporary ban from **${guild.name}**.`,
                `⏱️ **Duration:** ${prettySecs(durationSeconds)}`,
                `📅 **Expires:** <t:${Math.floor((Date.now() + durationSeconds * 1000) / 1000)}:F>`,
                reason ? `📝 **Reason:** ${reason}` : null,
              ].filter(Boolean).join('\n')
            );
          await actorUser.send({ embeds: [emb] });
        } catch (err) {
          dmFailed = true;
          log.debug({ userId: actorUser.id, error: err?.message }, 'Selfban DM failed');
        }
      }

      // Create infraction as self-initiated
      const infraction = await createInfractionWithCount({
        guildId: guild.id,
        userId: actorUser.id,
        moderatorId: actorUser.id, // mark as self-request
        type: 'ban',
        reason: reason || 'Self-ban requested',
        durationSeconds, // required for temp-ban in your schema constraints
        context: {
          selfInitiated: true,
          via: 'selfban_command',
        },
      });

      // Execute ban
      await guild.members.ban(actorUser, {
        reason: `[SELF] ${actorUser.tag}: ${reason || 'Self-ban requested'} (Temp: ${prettySecs(durationSeconds)})`,
        deleteMessageSeconds: delDays * 86400,
      });

      // Schedule unban
      const runAt = new Date(Date.now() + durationSeconds * 1000);
      const job = await enqueue({
        type: 'unban',
        guild_id: guild.id,
        user_id: actorUser.id,
        infraction_id: infraction.id,
        run_at: runAt,
        priority: 60,
        data: {
          selfInitiated: true,
          reason,
          duration: durationSeconds,
        },
      });
      log.info({ jobId: job.id, userId: actorUser.id, unbanAt: runAt.toISOString() }, 'Scheduled self-unban job');

      // Emit mod log & audit
      await emitModLog(interaction, {
        action: 'selfban',
        guildId: guild.id,
        actorId: actorUser.id,
        targetId: actorUser.id,
        reason,
        delDays,
        ts: Date.now(),
        caseId: infraction.id,
        temporary: true,
        duration: durationSeconds,
        dmFailed,
      });

      await logAudit({
        guildId: guild.id,
        actionType: 'selfban',
        actorId: actorUser.id,
        targetId: actorUser.id,
        details: {
          reason,
          caseId: infraction.id,
          deleteMessageDays: delDays,
          temporary: true,
          durationSeconds,
          dmFailed,
          selfInitiated: true,
        },
      });

      // Respond to user
      const msg = [
        `✅ **You have been temporarily banned**`,
        `⏱️ **Duration:** ${prettySecs(durationSeconds)}`,
        `📅 **Unban:** <t:${Math.floor((Date.now() + durationSeconds * 1000) / 1000)}:R>`,
        `📋 **Case ID:** \`${infraction.id}\``,
        reason ? `📝 **Reason:** ${reason}` : null,
        delDays ? `🗑️ **Deleted:** ${delDays} days of your recent messages` : null,
        dmFailed ? '⚠️ *Could not DM you before the ban*' : null,
      ].filter(Boolean).join('\n');

      return safeReply(interaction, { content: msg, flags: MessageFlags.Ephemeral });
    } catch (err) {
      log.error({ err, userId: actorUser.id }, 'Selfban error');

      if (err?.code === 50013) {
        return safeReply(interaction, {
          content: '❌ I lack permissions to ban you (role hierarchy). Contact a moderator.',
          flags: MessageFlags.Ephemeral,
        });
      }

      return safeReply(interaction, {
        content: '❌ Failed to process self-ban. Please try again later or contact staff.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
