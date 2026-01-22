// src/commands/moderation/slowmode.js - FIXED VERSION
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

const log = createLogger({ mod: "slowmode" });

export default {
  data: new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set or remove slowmode for a channel")
    .addStringOption((o) =>
      o
        .setName("delay")
        .setDescription(
          'Slowmode delay (e.g., 5s, 10s, 1m, 5m) or "off" to disable'
        )
        .setRequired(true)
        .setMaxLength(20)
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to set slowmode (default: current channel)")
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.PublicThread,
          ChannelType.PrivateThread
        )
    )
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription("How long to keep slowmode active (e.g., 1h, 30m)")
        .setMaxLength(20)
    )
    .addStringOption((o) =>
      o
        .setName("reason")
        .setDescription("Reason for setting slowmode")
        .setMaxLength(256)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false),

  requiredBotPerms: [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageThreads,
  ],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply();

    const channel =
      interaction.options.getChannel("channel") || interaction.channel;
    const delayStr = interaction.options
      .getString("delay", true)
      .trim()
      .toLowerCase();
    const durationStr = interaction.options.getString("duration");
    const reason =
      interaction.options.getString("reason")?.trim() || "No reason provided";

    // Validate channel type
    if (!channel.isTextBased() || channel.isDMBased()) {
      return safeReply(interaction, {
        content: "❌ Slowmode can only be set on text channels and threads.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Block announcement and stage channels
    if (
      channel.type === ChannelType.GuildAnnouncement ||
      channel.type === ChannelType.GuildStageVoice
    ) {
      return safeReply(interaction, {
        content: "❌ Slowmode cannot be set on announcement or stage channels.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Check for thread-specific issues
    if (channel.isThread()) {
      if (channel.archived) {
        return safeReply(interaction, {
          content: "❌ Cannot set slowmode on an archived thread.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Parse slowmode delay - handle common variations
    let slowmodeSeconds = 0;
    if (["off", "0", "none", "disable", "remove"].includes(delayStr)) {
      slowmodeSeconds = 0;
    } else {
      slowmodeSeconds = parseDurationSeconds(delayStr);
      if (!slowmodeSeconds || slowmodeSeconds < 0) {
        return safeReply(interaction, {
          content:
            "❌ Invalid delay format. Examples: `5s`, `10s`, `1m`, `5m` or `off`",
          flags: MessageFlags.Ephemeral,
        });
      }

      // Discord limits: 0-21600 seconds (6 hours)
      if (slowmodeSeconds > 21600) {
        return safeReply(interaction, {
          content: "❌ Slowmode delay cannot exceed 6 hours (Discord limit).",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Parse duration for temporary slowmode
    let tempDurationSeconds = null;
    if (durationStr && slowmodeSeconds > 0) {
      tempDurationSeconds = parseDurationSeconds(durationStr);

      if (!tempDurationSeconds || tempDurationSeconds <= 0) {
        return safeReply(interaction, {
          content: "❌ Invalid duration format. Examples: `30m`, `1h`, `6h`",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    try {
      // Set slowmode
      const previousDelay = channel.rateLimitPerUser || 0;
      await channel.setRateLimitPerUser(
        slowmodeSeconds,
        `[${interaction.user.tag}] ${reason.substring(0, 400)}`
      );

      // Use transaction for database operations
      const jobId = await tx(async (client) => {
        // Update channel config
        await client.query(
          `INSERT INTO channel_config (channel_id, guild_id, slowmode_seconds)
           VALUES ($1, $2, $3)
           ON CONFLICT (channel_id) 
           DO UPDATE SET slowmode_seconds = $3, updated_at = NOW()`,
          [channel.id, interaction.guildId, slowmodeSeconds]
        );

        // Schedule removal if temporary
        if (tempDurationSeconds && slowmodeSeconds > 0) {
          const removeAt = new Date(Date.now() + tempDurationSeconds * 1000);

          // Cancel existing slowmode_end jobs for this channel
          await client.query(
            `DELETE FROM scheduled_jobs 
             WHERE type = 'slowmode_end' 
               AND channel_id = $1 
               AND run_at > NOW()`,
            [channel.id]
          );

          // Create new job
          const {
            rows: [job],
          } = await client.query(
            `INSERT INTO scheduled_jobs (type, guild_id, channel_id, run_at, priority, data)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [
              "slowmode_end",
              interaction.guildId,
              channel.id,
              removeAt,
              40,
              JSON.stringify({
                setBy: interaction.user.id,
                previousDelay: previousDelay,
                reason: reason,
                idempotencyKey: `${channel.id}-${Date.now()}`,
              }),
            ]
          );

          log.info(
            {
              jobId: job.id,
              channelId: channel.id,
              removeAt: removeAt.toISOString(),
            },
            "Scheduled slowmode removal"
          );

          return job.id;
        }
        return null;
      });

      // Log to audit
      await logAudit({
        guildId: interaction.guildId,
        actionType: "slowmode_set",
        actorId: interaction.user.id,
        targetId: channel.id,
        details: {
          channelName: channel.name,
          previousDelay,
          slowmodeSeconds,
          reason,
          temporary: !!tempDurationSeconds,
          durationSeconds: tempDurationSeconds,
          jobId,
        },
      });

      // Build response
      if (slowmodeSeconds === 0) {
        return safeReply(interaction, {
          content: `✅ **Disabled slowmode in ${channel}**`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const removeTs = tempDurationSeconds
        ? Math.floor((Date.now() + tempDurationSeconds * 1000) / 1000)
        : null;

      const response = tempDurationSeconds
        ? [
            `${emojies.success} **Set slowmode in ${channel}**`,
            `> ${emojies.channelLock} **Delay:** ${prettySecs(
              slowmodeSeconds
            )}`,
            `> ${emojies.timeout} **Duration:** ${prettySecs(
              tempDurationSeconds
            )}`,
            `> ${emojies.modAction} **Removes:** <t:${removeTs}:F> (<t:${removeTs}:R>)`,
            reason ? `> ${emojies.questionMark} **Reason:** ${reason}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `${emojies.success} **Set slowmode in ${channel}**`,
            `> ${emojies.channelLock} **Delay:** ${prettySecs(
              slowmodeSeconds
            )}`,
            reason ? `> ${emojies.questionMark} **Reason:** ${reason}` : null,
          ]
            .filter(Boolean)
            .join("\n");

      return safeReply(interaction, {
        content: response,
      });
    } catch (err) {
      log.error({ err, channelId: channel.id }, "Failed to set slowmode");

      if (err.code === 50024) {
        return safeReply(interaction, {
          content: "❌ Cannot set slowmode on this channel type.",
          flags: MessageFlags.Ephemeral,
        });
      }

      return safeReply(interaction, {
        content: "❌ Failed to set slowmode. Please check my permissions.",
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
