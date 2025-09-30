// src/commands/moderation/case.js - FIXED VERSION
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import {
  ensureInGuild,
  safeReply,
  getColorForType,
} from "../../utils/moderation/mod.js";
import { query } from "../../core/db/index.js";
import { prettySecs, formatType } from "../../utils/moderation/duration.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger({ mod: "case" });

export default {
  data: new SlashCommandBuilder()
    .setName("case")
    .setDescription("View details of a moderation case")
    .addStringOption((o) => o.setName("id").setDescription("Case ID (UUID)"))
    .addUserOption((o) =>
      o.setName("user").setDescription("User to find cases for")
    )
    .addIntegerOption((o) =>
      o
        .setName("number")
        .setDescription("Case number for the user (1 = most recent)")
        .setMinValue(1)
        .setMaxValue(1000)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const caseId = interaction.options.getString("id")?.trim();
    const user = interaction.options.getUser("user");
    const caseNumber = interaction.options.getInteger("number");

    // Validate input
    if (!caseId && !user) {
      return safeReply(interaction, {
        content: "❌ Please provide either a case ID or a user.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (user && !caseNumber) {
      return safeReply(interaction, {
        content:
          "❌ When specifying a user, you must also provide a case number.",
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      let infraction;

      if (caseId) {
        // Validate UUID format
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            caseId
          )
        ) {
          return safeReply(interaction, {
            content: "❌ Invalid case ID format. Must be a valid UUID.",
            flags: MessageFlags.Ephemeral,
          });
        }

        // FIXED: Removed broken LATERAL joins
        const { rows } = await query(
          `SELECT * FROM infractions 
           WHERE id = $1 AND guild_id = $2`,
          [caseId, interaction.guildId]
        );

        infraction = rows[0];
      } else {
        // First check total case count for user
        const { rows: countRows } = await query(
          `SELECT COUNT(*)::int as total FROM infractions
           WHERE guild_id = $1 AND user_id = $2`,
          [interaction.guildId, user.id]
        );

        const totalCases = countRows[0]?.total || 0;

        if (totalCases === 0) {
          return safeReply(interaction, {
            content: `❌ No cases found for ${user.tag}.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        if (caseNumber > totalCases) {
          const { rows: latest } = await query(
            `SELECT created_at FROM infractions
             WHERE guild_id = $1 AND user_id = $2
             ORDER BY created_at DESC LIMIT 1`,
            [interaction.guildId, user.id]
          );

          return safeReply(interaction, {
            content: `❌ Only ${totalCases} case${
              totalCases !== 1 ? "s" : ""
            } found for ${user.tag}.\nLatest: <t:${Math.floor(
              new Date(latest[0].created_at).getTime() / 1000
            )}:F>`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // Fetch by user and case number
        const { rows } = await query(
          `SELECT * FROM infractions
           WHERE guild_id = $1 AND user_id = $2
           ORDER BY created_at DESC
           OFFSET $3 LIMIT 1`,
          [interaction.guildId, user.id, caseNumber - 1]
        );

        infraction = rows[0];
      }

      if (!infraction) {
        return safeReply(interaction, {
          content: "❌ Case not found.",
          flags: MessageFlags.Ephemeral,
        });
      }

      // Fetch user info
      let targetUser;
      try {
        targetUser = await interaction.client.users.fetch(infraction.user_id);
      } catch {
        targetUser = { tag: "Unknown User", id: infraction.user_id };
      }

      let modUser;
      try {
        modUser = await interaction.client.users.fetch(infraction.moderator_id);
      } catch {
        modUser = { tag: "Unknown Moderator", id: infraction.moderator_id };
      }

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle(`Case ${infraction.id.split("-")[0]}...`)
        .setColor(getColorForType(infraction.type))
        .addFields(
          { name: "Type", value: formatType(infraction.type), inline: true },
          {
            name: "User",
            value: `${targetUser.tag}\n\`${targetUser.id}\``,
            inline: true,
          },
          {
            name: "Moderator",
            value: `${modUser.tag}\n\`${modUser.id}\``,
            inline: true,
          },
          {
            name: "Reason",
            value: (infraction.reason || "No reason provided").substring(
              0,
              1024
            ),
            inline: false,
          },
          {
            name: "Date",
            value: `<t:${Math.floor(
              new Date(infraction.created_at).getTime() / 1000
            )}:F>`,
            inline: true,
          },
          {
            name: "Status",
            value: infraction.active ? "🟢 Active" : "🔴 Inactive",
            inline: true,
          }
        );

      // Add duration if applicable
      if (infraction.duration_seconds) {
        embed.addFields({
          name: "Duration",
          value: prettySecs(infraction.duration_seconds),
          inline: true,
        });
      }

      // Add expiry if applicable
      if (infraction.expires_at) {
        const expiryTime = Math.floor(
          new Date(infraction.expires_at).getTime() / 1000
        );
        const isExpired = new Date(infraction.expires_at) < new Date();
        embed.addFields({
          name: "Expires",
          value: isExpired
            ? `~~<t:${expiryTime}:F>~~ (Expired)`
            : `<t:${expiryTime}:F> (<t:${expiryTime}:R>)`,
          inline: true,
        });
      }

      // Add revoke info if applicable
      if (infraction.revoked_at) {
        let revokerUser;
        try {
          revokerUser = await interaction.client.users.fetch(
            infraction.revoker_id
          );
        } catch {
          revokerUser = { tag: "Unknown", id: infraction.revoker_id };
        }

        embed.addFields({
          name: "Revoked",
          value: `By ${revokerUser.tag}\n<t:${Math.floor(
            new Date(infraction.revoked_at).getTime() / 1000
          )}:R>`,
          inline: false,
        });
      }

      // Add context if present and not too large
      if (infraction.context && Object.keys(infraction.context).length > 0) {
        const contextStr = Object.entries(infraction.context)
          .filter(([k]) => k !== "isAuto") // Skip internal flags
          .map(([k, v]) => `**${k}:** ${String(v).substring(0, 100)}`)
          .join("\n");

        if (contextStr && contextStr.length <= 1024) {
          embed.addFields({
            name: "Context",
            value: contextStr,
            inline: false,
          });
        }
      }

      embed
        .setFooter({ text: `Case ID: ${infraction.id}` })
        .setTimestamp(new Date(infraction.created_at));

      return safeReply(interaction, {
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      log.error({ err }, "Failed to fetch case");
      return safeReply(interaction, {
        content: "❌ Failed to fetch case details. Database error.",
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
