// src/commands/moderation/history.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import { ensureInGuild, safeReply } from "../../utils/moderation/mod.js";
import { query } from "../../core/db/index.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger({ mod: "history" });

const MAX_DETAILS_PREVIEW = 180; // per-line JSON preview budget
const MAX_ROWS = 50;

export default {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("View recent moderation history (from audit logs)")
    .addIntegerOption((o) =>
      o
        .setName("limit")
        .setDescription("How many entries (1–50, default 10)")
        .setMinValue(1)
        .setMaxValue(MAX_ROWS)
    )
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription('Filter by action type (e.g., "ban", "warn", "purge")')
    )
    .addUserOption((o) =>
      o
        .setName("actor")
        .setDescription("Filter by the user who performed the action")
    )
    .addBooleanOption((o) =>
      o.setName("ephemeral").setDescription("Reply ephemerally (default: true)")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);

    const ephemeral = interaction.options.getBoolean("ephemeral") ?? true;
    await interaction.deferReply(
      ephemeral ? { flags: MessageFlags.Ephemeral } : undefined
    );

    const limit = interaction.options.getInteger("limit") ?? 10;
    const actionFilterRaw = interaction.options.getString("action")?.trim();
    const actorFilter = interaction.options.getUser("actor")?.id ?? null;

    try {
      const params = [interaction.guildId];
      let sql = `
        SELECT id, action_type, actor_id, target_id, details, timestamp
        FROM audit_logs
        WHERE guild_id = $1
      `;

      if (actionFilterRaw) {
        // case-insensitive contains match for convenience
        sql += ` AND action_type ILIKE $${params.length + 1}`;
        params.push(`%${actionFilterRaw}%`);
      }
      if (actorFilter) {
        sql += ` AND actor_id = $${params.length + 1}`;
        params.push(actorFilter);
      }

      sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
      params.push(Math.min(limit, MAX_ROWS));

      const { rows } = await query(sql, params);

      if (rows.length === 0) {
        return safeReply(interaction, {
          content: "ℹ️ No recent history matched your criteria.",
          flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      }

      // Build a compact, safe embed
      const titleParts = [`Recent History`, `(${rows.length})`];
      const embed = new EmbedBuilder()
        .setTitle(titleParts.join(" "))
        .setColor(0x4f46e5)
        .setTimestamp();

      const lines = rows.map((r) => {
        const ts = Math.floor(new Date(r.timestamp).getTime() / 1000);
        const actor = r.actor_id ? `<@${r.actor_id}>` : "`unknown`";
        const target = r.target_id ? `<@${r.target_id}>` : "`unknown`";
        // short JSON preview
        let preview = "";
        if (r.details && typeof r.details === "object") {
          try {
            preview = JSON.stringify(r.details);
            if (preview.length > MAX_DETAILS_PREVIEW) {
              preview = preview.slice(0, MAX_DETAILS_PREVIEW - 1) + "…";
            }
          } catch {
            preview = "[unserializable details]";
          }
        }
        return [
          `**${r.action_type.toUpperCase()}** • <t:${ts}:R>`,
          `Actor: ${actor} → Target: ${target}`,
          preview ? `*Details:* \`${preview}\`` : null,
        ]
          .filter(Boolean)
          .join("\n");
      });

      // Discord embed description max ~4096; trim if needed
      let desc = lines.join("\n\n");
      if (desc.length > 4000) {
        // hard trim at a safe boundary
        desc = desc.slice(0, 3995) + "…";
      }
      embed.setDescription(desc);

      return safeReply(interaction, {
        embeds: [embed],
        ...(ephemeral && { flags: MessageFlags.Ephemeral }),
      });
    } catch (err) {
      log.error({ err }, "History fetch failed");
      return safeReply(interaction, {
        content: "❌ Failed to retrieve history. Please try again later.",
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
      });
    }
  },
};
