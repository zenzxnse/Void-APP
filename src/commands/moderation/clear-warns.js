import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import {
  ensureInGuild,
  checkHierarchy,
  humanizeError,
  safeReply,
  emitModLog,
} from '../../utils/moderation/mod.js';
import {
  clearUserWarns,
  logAudit,
  getGuildConfig,
} from '../../utils/moderation/mod-db.js';
import { emojies } from '../../graphics/colors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('clear-warns')
    .setDescription('Clear all active warnings for a member.')
    .addUserOption(o =>
      o
        .setName('user')
        .setDescription('Member to clear warnings for')
        .setRequired(true),
    )
    .addStringOption(o =>
      o
        .setName('note')
        .setDescription('Optional note for audit/modlog')
        .setMaxLength(512),
    )
    .addBooleanOption(o =>
      o
        .setName('silent')
        .setDescription('Do not DM the user'),
    )
    .addBooleanOption(o =>
      o
        .setName('ephemeral')
        .setDescription('Respond privately (ephemeral)'), // defaults to false
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);

    const eph = interaction.options.getBoolean('ephemeral') ?? false;
    const ephFlags = eph ? MessageFlags.Ephemeral : 0;

    const targetUser = interaction.options.getUser('user', true);
    const note = interaction.options.getString('note') ?? null;
    const silent = interaction.options.getBoolean('silent') ?? false;

    // Fetch target member
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) {
      return safeReply(interaction, {
        content: '❌ That user is not in this server.',
        flags: ephFlags,
      });
    }

    // Hierarchy check
    const hier = checkHierarchy({
      guild: interaction.guild,
      me: interaction.guild.members.me,
      actor: interaction.member,
      target,
    });
    if (!hier.ok) {
      return safeReply(interaction, {
        content: humanizeError(hier.why),
        flags: ephFlags,
      });
    }

    try {
      // Clear warns
      const cleared = await clearUserWarns({
        guildId: interaction.guildId,
        userId: target.id,
        revokerId: interaction.user.id,
        clearReason: note,
      });

      if (!cleared.length) {
        return safeReply(interaction, {
          content: `❌ ${target.user.tag} has no active warnings to clear.`,
          flags: ephFlags,
        });
      }

      // DM user if enabled
      const { dm_on_action: dmOnAction } = await getGuildConfig(
        interaction.guildId,
        'dm_on_action',
      );
      let dmFailed = false;

      if (!silent && dmOnAction) {
        try {
          await target.send({
            content:
              `${emojies.success} **Your warnings have been cleared in ${interaction.guild.name}**\n` +
              `> **Total removed:** ${cleared.length}\n` +
              (note ? `> **Note:** ${note}\n` : ''),
          });
        } catch (err) {
          dmFailed = true;
          await logAudit({
            guildId: interaction.guildId,
            actionType: 'dm_failed',
            actorId: interaction.user.id,
            targetId: target.id,
            details: {
              action: 'clear_warns',
              error: err.message,
              caseIds: cleared.map(c => c.id),
            },
          });
        }
      }

      // Mod log
      await emitModLog(interaction, {
        action: 'clear_warns',
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetId: target.id,
        reason: note ?? undefined,
        ts: Date.now(),
        extra: {
          clearedCount: cleared.length,
          caseIds: cleared.map(c => c.id),
        },
        dmFailed,
      });

      // Audit log
      await logAudit({
        guildId: interaction.guildId,
        actionType: 'clear_warns',
        actorId: interaction.user.id,
        targetId: target.id,
        details: {
          clearedCount: cleared.length,
          caseIds: cleared.map(c => c.id),
          note,
          dmFailed,
        },
      });

      // Build response
      const response = [
        `${emojies.modAction} **Cleared warnings for ${target.user.tag}**`,
        `> ${emojies.success} **Total removed:** ${cleared.length}`,
        note ? `> ${emojies.questionMark} **Note:** ${note}` : null,
        dmFailed ? `${emojies.error} *Could not DM user*` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return safeReply(interaction, {
        content: response,
        flags: ephFlags,
      });
    } catch (err) {
      console.error('clear-warns command error:', err);
      return safeReply(interaction, {
        content: `${emojies.error} Failed to clear warnings. Please try again or contact an administrator.`,
        flags: ephFlags,
      });
    }
  },
};
