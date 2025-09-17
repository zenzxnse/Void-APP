// src/commands/moderation/backup.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} from 'discord.js';
import Papa from 'papaparse';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { query } from '../../core/db/index.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'backup' });

// simple allowlist for custom action names (defense-in-depth; query is parameterized anyway)
const ACTION_NAME_RE = /^[a-z0-9_:.~-]+$/i;

export default {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Export recent server audit logs')
    .addStringOption(o => o
      .setName('type')
      .setDescription('Log type to export')
      .addChoices(
        { name: 'All', value: 'all' },
        { name: 'Bans', value: 'ban' },     // matches action_type like 'ban', 'unban', 'softban'
        { name: 'Warns', value: 'warn' },   // matches 'warn'
        { name: 'Custom', value: 'custom' } // exact match
      ))
    .addStringOption(o => o
      .setName('custom_action')
      .setDescription('Exact action_type (e.g. "channel_lock" or "purge")'))
    .addIntegerOption(o => o
      .setName('limit')
      .setDescription('Max entries (1–100, default 100)')
      .setMinValue(1)
      .setMaxValue(100))
    .addStringOption(o => o
      .setName('format')
      .setDescription('Export format')
      .addChoices(
        { name: 'CSV', value: 'csv' },
        { name: 'JSON', value: 'json' },
      ))
    .addBooleanOption(o => o
      .setName('ephemeral')
      .setDescription('Reply ephemerally (default: true)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  cooldownMs: 30000,

  async execute(interaction) {
    ensureInGuild(interaction);

    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    const logType = interaction.options.getString('type') ?? 'all';
    const customAction = interaction.options.getString('custom_action')?.trim();
    const limit = interaction.options.getInteger('limit') ?? 100;
    const fmt = interaction.options.getString('format') ?? 'csv';

    if (logType === 'custom') {
      if (!customAction) {
        return safeReply(interaction, {
          content: '❌ Please provide a **custom_action** when type is set to *Custom*.',
          flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      }
      if (!ACTION_NAME_RE.test(customAction)) {
        return safeReply(interaction, {
          content: '❌ The provided **custom_action** contains invalid characters.',
          flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      }
    }

    try {
      // Build filtered query
      const params = [interaction.guildId];
      let sql = `
        SELECT id, guild_id, action_type, actor_id, target_id, details, timestamp
        FROM audit_logs
        WHERE guild_id = $1
      `;

      if (logType === 'ban') {
        // ban-like actions: 'ban', 'unban', 'softban'
        sql += ` AND action_type = ANY($${params.length + 1})`;
        params.push(['ban', 'unban', 'softban']);
      } else if (logType === 'warn') {
        sql += ` AND action_type = $${params.length + 1}`;
        params.push('warn');
      } else if (logType === 'custom') {
        sql += ` AND action_type = $${params.length + 1}`;
        params.push(customAction);
      }
      sql += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const { rows } = await query(sql, params);

      if (rows.length === 0) {
        return safeReply(interaction, {
          content: 'ℹ️ No audit log entries matched your criteria.',
          flags: ephemeral ? MessageFlags.Ephemeral : undefined,
        });
      }

      const now = new Date();
      const baseName = `audit-${interaction.guildId}-${now.toISOString().replace(/[:.]/g, '-')}`;
      let attachment;

      if (fmt === 'json') {
        // stringify with stable keys and pretty print
        const payload = rows.map(r => ({
          id: r.id,
          guild_id: r.guild_id,
          action_type: r.action_type,
          actor_id: r.actor_id,
          target_id: r.target_id,
          details: r.details, // already JSON
          timestamp: new Date(r.timestamp).toISOString(),
        }));
        const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
        attachment = new AttachmentBuilder(buf, { name: `${baseName}.json` });
      } else {
        // CSV (stable column order + JSON details serialized)
        const fields = ['id', 'guild_id', 'action_type', 'actor_id', 'target_id', 'details', 'timestamp'];
        const data = rows.map(r => ([
          r.id,
          r.guild_id,
          r.action_type,
          r.actor_id,
          r.target_id,
          JSON.stringify(r.details ?? {}),
          new Date(r.timestamp).toISOString(),
        ]));
        const csv = Papa.unparse({ fields, data }, { header: true, quotes: true });
        const buf = Buffer.from(csv, 'utf8');
        attachment = new AttachmentBuilder(buf, { name: `${baseName}.csv` });
      }

      await safeReply(interaction, {
        content: `✅ Exported **${rows.length}** audit log entr${rows.length === 1 ? 'y' : 'ies'}.`,
        files: [attachment],
        ...(ephemeral && { flags: MessageFlags.Ephemeral }),
      });

      log.info({ guildId: interaction.guildId, count: rows.length, type: logType, fmt }, 'Audit log export completed');
    } catch (err) {
      log.error({ err }, 'Audit log export failed');
      return safeReply(interaction, {
        content: '❌ Failed to generate export. Please try again later.',
        flags: ephemeral ? MessageFlags.Ephemeral : undefined,
      });
    }
  },
};
