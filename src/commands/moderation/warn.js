import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import {
  ensureInGuild,
  normalizeReason,
  safeReply,
  emitModLog,
} from "../../utils/moderation/mod.js";
import {
  createInfractionWithCount,
  getAutoAction,
  getGuildConfig,
  logAudit,
} from "../../utils/moderation/mod-db.js";
import {
  parseDurationSeconds,
  prettySecs,
} from "../../utils/moderation/duration.js";
import { applyModAction } from "../../utils/moderation/mod-actions.js";
import { tx } from "../../core/db/index.js";
import { emojies } from "../../graphics/colors.js";

// Rate limiting map: `${guildId}:${modId}:${targetId}` -> timestamp
const warnRateLimit = new Map();
const RATE_LIMIT_MS = 5000; // 5 seconds between warns for same target by same mod

export default {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member.")
    .addUserOption((o) =>
      o.setName("user").setDescription("Member to warn").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("reason")
        .setDescription("Reason for the warn")
        .setMaxLength(1024)
    )
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription("How long this warn stays active (e.g. 7d, 12h, 45m)")
    )
    .addBooleanOption((o) =>
      o.setName("silent").setDescription("Do not DM the user")
    )
    .addBooleanOption((o) =>
      o.setName("ephemeral").setDescription("Respond privately (ephemeral)")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);

    const eph = interaction.options.getBoolean("ephemeral") ?? false;
    const ephFlag = eph ? MessageFlags.Ephemeral : 0;

    await interaction.deferReply({ flags: ephFlag });

    const targetUser = interaction.options.getUser("user", true);
    const reason = normalizeReason(interaction.options.getString("reason"));
    const silent = interaction.options.getBoolean("silent") ?? false;
    const durationStr = interaction.options.getString("duration");

    // Validate duration if provided
    let durationSeconds = null;
    if (durationStr) {
      const seconds = parseDurationSeconds(durationStr);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return safeReply(interaction, {
          content: "❌ Invalid duration.",
          flags: ephFlag,
        });
      }
      const MAX_WARN_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days
      if (seconds > MAX_WARN_DURATION_SECONDS) {
        return safeReply(interaction, {
          content: "❌ Duration cannot exceed 90 days.",
          flags: ephFlag,
        });
      }
      durationSeconds = seconds; // stay in seconds
    }

    // Fetch target member (must be in guild to receive a guild warn)
    const target = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);
    if (!target) {
      return safeReply(interaction, {
        content: "❌ That user is not in this server.",
        flags: ephFlag,
      });
    }

    // ❗ No hierarchy checks — moderators can warn anyone, including owner.

    // Rate limiting check
    const rateLimitKey = `${interaction.guildId}:${interaction.user.id}:${target.id}`;
    const lastWarn = warnRateLimit.get(rateLimitKey);
    const now = Date.now();

    if (lastWarn && now - lastWarn < RATE_LIMIT_MS) {
      const remaining = Math.ceil((RATE_LIMIT_MS - (now - lastWarn)) / 1000);
      return safeReply(interaction, {
        content: `⏳ Please wait ${remaining} seconds before warning this user again.`,
        flags: ephFlag,
      });
    }

    try {
      // Use transaction for atomic warn creation and count
      const result = await tx(async (client) => {
        const infraction = await createInfractionWithCount({
          client,
          guildId: interaction.guildId,
          userId: target.id,
          moderatorId: interaction.user.id,
          type: "warn",
          reason,
          durationSeconds,
        });

        const autoAction = await getAutoAction(
          interaction.guildId,
          infraction.warnCount
        );
        return { infraction, autoAction };
      });

      const { infraction, autoAction } = result;
      warnRateLimit.set(rateLimitKey, now);

      // Clean stale rate-limit entries occasionally
      if (warnRateLimit.size > 100) {
        for (const [key, ts] of warnRateLimit) {
          if (now - ts > RATE_LIMIT_MS * 2) warnRateLimit.delete(key);
        }
      }

      // Optional auto-action (may fail due to perms/hierarchy; warn still stands)
      let autoMsg = "";
      let autoInfraction = null;

      if (autoAction && autoAction.action !== "none") {
        try {
          const {
            applied,
            infraction: autoInf,
            msg,
          } = await applyModAction({
            guild: interaction.guild,
            target,
            actorId: interaction.user.id,
            action: autoAction.action,
            durationSeconds: autoAction.duration_seconds,
            reason: `Auto-escalation after ${infraction.warnCount} warns${
              reason ? `: ${reason}` : ""
            }`,
            context: { fromWarnId: infraction.id },
            isAuto: true,
          });

          if (applied) {
            const duration = autoAction.duration_seconds
              ? ` for ${prettySecs(autoAction.duration_seconds)}`
              : "";
            autoMsg = `\n🔨 **Auto-action triggered:** ${autoAction.action}${duration}`;
            autoInfraction = autoInf;
            if (autoInf) {
              await tx(async (client) => {
                await client.query(
                  `UPDATE infractions SET replaced_by = $1 WHERE id = $2`,
                  [autoInf.id, infraction.id]
                );
              });
            }
          } else {
            autoMsg = `\n⚠️ Auto-action failed: ${
              msg || "insufficient permissions or role hierarchy"
            }`;
          }
        } catch (err) {
          console.error("Auto-action error:", err);
          autoMsg = "\n⚠️ Auto-action failed due to an error.";
        }
      }

      // Try to DM the user
      const { dm_on_action: dmOnAction } = await getGuildConfig(
        interaction.guildId,
        "dm_on_action"
      );
      let dmFailed = false;

      if (!silent && dmOnAction) {
        try {
          // Build optional auto-action line for the DM
          const autoDmLine =
            autoAction && autoAction.action !== "none"
              ? `${emojies.banHammer} **Auto-action:** ${autoAction.action}${
                  autoAction.duration_seconds
                    ? ` for ${prettySecs(autoAction.duration_seconds)}`
                    : ""
                }`
              : null;

          const dmEmbed = new EmbedBuilder()
            .setColor(0x2f3136) // #2F3136
            .setAuthor({
              name: interaction.guild.name,
              iconURL: interaction.guild.iconURL({ size: 128 }) ?? undefined,
            })
            .setTitle(`${emojies.modAction} You were warned`)
            .setDescription(
              [
                `You received a warning in **${interaction.guild.name}**.`,
                "",
                reason ? `> **Reason:** ${reason}` : null,
                `> **Case ID:** \`${infraction.id}\``,
                `> **Total warnings:** ${infraction.warnCount}`,
                autoDmLine ? `\n${autoDmLine}` : null,
              ]
                .filter(Boolean)
                .join("\n")
            )
            .setFooter({
              text: "Please review the server rules. Repeated infractions may lead to further action.",
            })
            .setTimestamp();

          await target.send({ embeds: [dmEmbed] });
        } catch (err) {
          dmFailed = true;
          await logAudit({
            guildId: interaction.guildId,
            actionType: "dm_failed",
            actorId: interaction.user.id,
            targetId: target.id,
            details: {
              action: "warn",
              error: err.message,
              caseId: infraction.id,
            },
          });
        }
      }

      // Mod log
      await emitModLog(interaction, {
        action: "warn",
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetId: target.id,
        reason,
        ts: Date.now(),
        caseId: infraction.id,
        autoAction: autoAction?.action,
        autoCaseId: autoInfraction?.id,
        dmFailed,
      });

      // Audit log
      await logAudit({
        guildId: interaction.guildId,
        actionType: "warn",
        actorId: interaction.user.id,
        targetId: target.id,
        details: {
          reason,
          caseId: infraction.id,
          autoAction: autoAction?.action,
          warnCount: infraction.warnCount,
          dmFailed,
        },
      });

      // Build response
      const response = [
        `${emojies.modAction} **Warned ${target.user.tag}**`,
        `> **Case ID:** \`${infraction.id}\``,
        `> **Total warnings:** ${infraction.warnCount}`,
        reason ? `> **Reason:** ${reason}` : null,
        durationSeconds
          ? `${emojies.timeout} **Duration:** ${prettySecs(durationSeconds)}`
          : null,
        autoMsg || null,
        dmFailed ? `${emojies.voidEye} *Could not DM user*` : null,
      ]
        .filter(Boolean)
        .join("\n");

      return safeReply(interaction, {
        content: response,
        flags: ephFlag,
      });
    } catch (err) {
      console.error("Warn command error:", err);
      return safeReply(interaction, {
        content: `${emojies.error} Failed to issue warning. Please try again or contact an administrator.`,
        flags: ephFlag,
      });
    }
  },
};
