// src/commands/moderation/lock.js - FIXED VERSION
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} from "discord.js";
import { ensureInGuild, safeReply } from "../../utils/moderation/mod.js";
import {
  parseDurationSeconds,
  prettySecs,
} from "../../utils/moderation/duration.js";
import { enqueue } from "../../core/db/jobs.js";
import { tx } from "../../core/db/index.js";
import { logAudit } from "../../utils/moderation/mod-db.js";
import { createLogger } from "../../core/logger.js";
import { emojies } from "../../graphics/colors.js";

const log = createLogger({ mod: "lock" });

export default {
  data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock a channel (disable sending messages for @everyone)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to lock (default: current channel)")
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread
        )
    )
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription(
          "Duration for temporary lock (e.g., 1h, 30m). Leave empty for permanent."
        )
        .setMaxLength(20)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for locking").setMaxLength(256)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  requiredBotPerms: [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageThreads,
  ],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel =
      interaction.options.getChannel("channel") || interaction.channel;
    const durationStr = interaction.options.getString("duration");
    const reason =
      interaction.options.getString("reason")?.trim() || "No reason provided";

    // Validate channel type
    if (!channel.isTextBased() || channel.isDMBased()) {
      return safeReply(interaction, {
        content: "❌ This command can only be used on text channels.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Check for thread-specific issues
    if (channel.isThread()) {
      if (channel.archived) {
        return safeReply(interaction, {
          content: "❌ Cannot lock an archived thread. Unarchive it first.",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (channel.locked) {
        return safeReply(interaction, {
          content: "❌ This thread is already locked.",
          flags: MessageFlags.Ephemeral,
        });
      }
      // For threads, we lock the thread itself, not apply overwrites
      try {
        await channel.setLocked(true, `[${interaction.user.tag}] ${reason}`);
      } catch (err) {
        log.error({ err, channelId: channel.id }, "Failed to lock thread");
        return safeReply(interaction, {
          content: "❌ Failed to lock thread. Check my permissions.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } else {
      // For regular channels, check existing overwrites
      const everyone = interaction.guild.roles.everyone;
      const currentPerms = channel.permissionOverwrites.cache.get(everyone.id);
      const isLocked = currentPerms?.deny?.has(
        PermissionFlagsBits.SendMessages
      );

      if (isLocked) {
        return safeReply(interaction, {
          content: "❌ This channel is already locked.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Parse duration for temporary lock
    let durationSeconds = null;
    let isTemporary = false;

    if (durationStr) {
      durationSeconds = parseDurationSeconds(durationStr);

      if (!durationSeconds || durationSeconds <= 0) {
        return safeReply(interaction, {
          content:
            "❌ Invalid duration format. Examples: `30m`, `1h`, `6h`, `1d`",
          flags: MessageFlags.Ephemeral,
        });
      }

      // Max 30 days for temp lock
      const MAX_LOCK_DURATION = 30 * 24 * 60 * 60;
      if (durationSeconds > MAX_LOCK_DURATION) {
        return safeReply(interaction, {
          content: "❌ Lock duration cannot exceed 30 days.",
          flags: MessageFlags.Ephemeral,
        });
      }

      isTemporary = true;
    }

    try {
      // Send notification BEFORE locking (to ensure it goes through)
      let notificationSent = false;
      if (!channel.isThread()) {
        const { EmbedBuilder } = await import("discord.js");
        const embed = new EmbedBuilder()
          .setColor(0x2c2f33) // dark grey
          .setTitle(`${emojies.channelLock} Locked ${channel}`)
          .setDescription(
        isTemporary
          ? [
          `> ${emojies.timeout} **Duration:** ${prettySecs(durationSeconds)}`,
          `> **Unlocks:** <t:${Math.floor(
            (Date.now() + durationSeconds * 1000) / 1000
          )}:F>`,
          `> ${emojies.questionMark} **Reason:** ${reason}`,
            ].join("\n")
          : [
          `> ${emojies.questionMark} **Reason:** ${reason}`,
          `> ${emojies.lock} Use \`/unlock\` to manually unlock`,
            ].join("\n")
          );

        try {
          await channel.send({ embeds: [embed] });
          notificationSent = true;
        } catch (err) {
          log.debug({ err }, "Could not send lock notification to channel");
        }
      }

      // Lock the channel (for non-threads)
      if (!channel.isThread()) {
        const everyone = interaction.guild.roles.everyone;
        await channel.permissionOverwrites.edit(
          everyone,
          {
            SendMessages: false,
            SendMessagesInThreads: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          },
          {
            reason: `[${interaction.user.tag}] ${reason}${
              isTemporary ? ` (Temp: ${prettySecs(durationSeconds)})` : ""
            }`,
          }
        );
      }

      // Use transaction for database operations
      const jobId = await tx(async (client) => {
        // Update channel config
        await client.query(
          `INSERT INTO channel_config (channel_id, guild_id, lockdown_enabled)
           VALUES ($1, $2, TRUE)
           ON CONFLICT (channel_id) 
           DO UPDATE SET lockdown_enabled = TRUE, updated_at = NOW()`,
          [channel.id, interaction.guildId]
        );

        // Schedule unlock if temporary
        if (isTemporary) {
          const unlockAt = new Date(Date.now() + durationSeconds * 1000);

          // Check for existing job first
          const { rows: existing } = await client.query(
            `SELECT id FROM scheduled_jobs 
             WHERE type = 'lockdown_end' 
               AND channel_id = $1 
               AND run_at > NOW()`,
            [channel.id]
          );

          if (existing.length > 0) {
            // Update existing job
            await client.query(
              `UPDATE scheduled_jobs 
               SET run_at = $1, data = $2, attempts = 0
               WHERE id = $3`,
              [
                unlockAt,
                JSON.stringify({
                  lockedBy: interaction.user.id,
                  reason: reason,
                  duration: durationSeconds,
                }),
                existing[0].id,
              ]
            );
            return existing[0].id;
          } else {
            // Create new job
            const {
              rows: [job],
            } = await client.query(
              `INSERT INTO scheduled_jobs (type, guild_id, channel_id, run_at, priority, data)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id`,
              [
                "lockdown_end",
                interaction.guildId,
                channel.id,
                unlockAt,
                50,
                JSON.stringify({
                  lockedBy: interaction.user.id,
                  reason: reason,
                  duration: durationSeconds,
                }),
              ]
            );
            return job.id;
          }
        }
        return null;
      });

      if (jobId) {
        log.info({ jobId, channelId: channel.id }, "Scheduled unlock job");
      }

      // Log to audit
      await logAudit({
        guildId: interaction.guildId,
        actionType: "channel_lock",
        actorId: interaction.user.id,
        targetId: channel.id,
        details: {
          channelName: channel.name,
          channelType: channel.type,
          reason,
          temporary: isTemporary,
          durationSeconds,
          jobId,
          notificationSent,
        },
      });

      // Response
      const response = isTemporary
        ? [
            `${emojies.channelLock} **Locked ${channel}**`,
            `> ${emojies.timeout} **Duration:** ${prettySecs(durationSeconds)}`,
            `> **Unlocks:** <t:${Math.floor(
              (Date.now() + durationSeconds * 1000) / 1000
            )}:F>`,
            `> ${emojies.questionMark} **Reason:** ${reason}`,
          ].join("\n")
        : [
            `${emojies.channelLock} **Locked ${channel}**`,
            `> ${emojies.questionMark} **Reason:** ${reason}`,
            `> ${emojies.lock} Use \`/unlock\` to manually unlock`,
          ].join("\n");

      return safeReply(interaction, {
        content: response,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      log.error({ err, channelId: channel.id }, "Failed to lock channel");
      return safeReply(interaction, {
        content: `${emojies.error} Failed to lock channel. Please check my permissions.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
