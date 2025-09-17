// src/commands/moderation/note.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { query, tx } from '../../core/db/index.js';
import { logAudit } from '../../utils/moderation/mod-db.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'note' });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  data: new SlashCommandBuilder()
    .setName('note')
    .setDescription('Add, list, edit, or delete staff notes for a user')
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Add a staff note for a user')
        .addUserOption(o => o
          .setName('user')
          .setDescription('User to attach the note to')
          .setRequired(true))
        .addStringOption(o => o
          .setName('text')
          .setDescription('The note text (staff-only)')
          .setRequired(true)
          .setMaxLength(1000)),
    )
    .addSubcommand(sc =>
      sc.setName('list')
        .setDescription('List recent notes for a user')
        .addUserOption(o => o
          .setName('user')
          .setDescription('User whose notes to view')
          .setRequired(true))
        .addIntegerOption(o => o
          .setName('limit')
          .setDescription('How many notes to show (1–20)')
          .setMinValue(1)
          .setMaxValue(20)),
    )
    .addSubcommand(sc =>
      sc.setName('edit')
        .setDescription('Edit a note (note ID required)')
        .addStringOption(o => o
          .setName('id')
          .setDescription('Note ID (UUID)')
          .setRequired(true))
        .addStringOption(o => o
          .setName('text')
          .setDescription('New note text')
          .setRequired(true)
          .setMaxLength(1000)),
    )
    .addSubcommand(sc =>
      sc.setName('delete')
        .setDescription('Delete a note (note ID required)')
        .addStringOption(o => o
          .setName('id')
          .setDescription('Note ID (UUID)')
          .setRequired(true)),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  // /note does not require special bot perms
  requiredBotPerms: [],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand(true);

    try {
      if (sub === 'add') {
        const target = interaction.options.getUser('user', true);
        const text = interaction.options.getString('text', true).trim();

        // Insert note
        const { rows: [note] } = await query(
          `INSERT INTO user_notes (guild_id, user_id, moderator_id, note)
           VALUES ($1, $2, $3, $4)
           RETURNING id, user_id, moderator_id, note, created_at, updated_at`,
          [interaction.guildId, target.id, interaction.user.id, text],
        );

        // Audit
        await logAudit({
          guildId: interaction.guildId,
          actionType: 'note_add',
          actorId: interaction.user.id,
          targetId: target.id,
          details: {
            noteId: note.id,
            preview: text.slice(0, 120),
            length: text.length,
          },
        });

        return safeReply(interaction, {
          content: [
            `✅ **Added note for ${target.tag}**`,
            `🆔 **Note ID:** \`${note.id}\``,
            `📝 **Note:** ${text.length > 1800 ? `${text.slice(0, 1800)}…` : text}`,
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'list') {
        const target = interaction.options.getUser('user', true);
        const limit = interaction.options.getInteger('limit') ?? 5;

        const { rows } = await query(
          `SELECT id, moderator_id, note, created_at, updated_at
           FROM user_notes
           WHERE guild_id = $1 AND user_id = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [interaction.guildId, target.id, limit],
        );

        if (rows.length === 0) {
          return safeReply(interaction, {
            content: `ℹ️ **No notes** found for ${target.tag}.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // Try to resolve moderator tags (best-effort)
        const modTags = new Map();
        await Promise.all(rows.map(async (r) => {
          if (!modTags.has(r.moderator_id)) {
            try {
              const u = await interaction.client.users.fetch(r.moderator_id);
              modTags.set(r.moderator_id, u.tag);
            } catch {
              modTags.set(r.moderator_id, r.moderator_id);
            }
          }
        }));

        const lines = rows.map(r => {
          const created = Math.floor(new Date(r.created_at).getTime() / 1000);
          const mod = modTags.get(r.moderator_id) || r.moderator_id;
          const body = r.note.length > 300 ? `${r.note.slice(0, 300)}…` : r.note;
          return [
            `• **${r.id}**`,
            ` by \`${mod}\``,
            ` — <t:${created}:R>\n`,
            body,
          ].join('');
        });

        const embed = new EmbedBuilder()
          .setTitle(`Notes for ${target.tag}`)
          .setColor(0x808080)
          .setDescription(lines.join('\n\n').slice(0, 4000))
          .setFooter({ text: `Requested by ${interaction.user.tag}` })
          .setTimestamp();

        return safeReply(interaction, {
          embeds: [embed],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'edit') {
        const id = interaction.options.getString('id', true).trim();
        const text = interaction.options.getString('text', true).trim();

        if (!UUID_RE.test(id)) {
          return safeReply(interaction, {
            content: '❌ Invalid note ID format. Must be a UUID.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const result = await tx(async (client) => {
          const { rows: [existing] } = await client.query(
            `SELECT id, user_id, note FROM user_notes
             WHERE id = $1 AND guild_id = $2`,
            [id, interaction.guildId],
          );

          if (!existing) return { ok: false };

          await client.query(
            `UPDATE user_notes
             SET note = $1, updated_at = NOW()
             WHERE id = $2`,
            [text, id],
          );

          return {
            ok: true,
            userId: existing.user_id,
            oldPreview: existing.note.slice(0, 120),
          };
        });

        if (!result.ok) {
          return safeReply(interaction, {
            content: '❌ Note not found in this server.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await logAudit({
          guildId: interaction.guildId,
          actionType: 'note_edit',
          actorId: interaction.user.id,
          targetId: result.userId,
          details: {
            noteId: id,
            oldPreview: result.oldPreview,
            newPreview: text.slice(0, 120),
          },
        });

        return safeReply(interaction, {
          content: `✏️ **Edited note** \`${id}\``,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'delete') {
        const id = interaction.options.getString('id', true).trim();

        if (!UUID_RE.test(id)) {
          return safeReply(interaction, {
            content: '❌ Invalid note ID format. Must be a UUID.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const { rows: [deleted] } = await query(
          `DELETE FROM user_notes
           WHERE id = $1 AND guild_id = $2
           RETURNING id, user_id, moderator_id, note`,
          [id, interaction.guildId],
        );

        if (!deleted) {
          return safeReply(interaction, {
            content: '❌ Note not found in this server.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await logAudit({
          guildId: interaction.guildId,
          actionType: 'note_delete',
          actorId: interaction.user.id,
          targetId: deleted.user_id,
          details: {
            noteId: deleted.id,
            preview: deleted.note.slice(0, 120),
          },
        });

        return safeReply(interaction, {
          content: `🗑️ **Deleted note** \`${deleted.id}\``,
          flags: MessageFlags.Ephemeral,
        });
      }

      // Fallback (shouldn’t happen)
      return safeReply(interaction, {
        content: '❌ Unknown subcommand.',
        flags: MessageFlags.Ephemeral,
      });

    } catch (err) {
      log.error({ err }, 'Note command error');
      return safeReply(interaction, {
        content: '❌ Failed to process note. Please try again.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
