import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
} from 'discord.js';
import {
  ensureInGuild, checkHierarchy, humanizeError, safeReply, emitModLog
} from '../../utils/moderation/mod.js';
import { query } from '../../core/db/index.js';
import { revokeWarn, logAudit, getGuildConfig } from '../../utils/moderation/mod-db.js';
import { emojies } from '../../graphics/colors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Remove a specific active warn from a member.')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption(o => o.setName('warn_no').setDescription('Warn number as shown in /warns (1 = most recent)').setMinValue(1).setMaxValue(100))
    .addStringOption(o => o.setName('case_id').setDescription('Warn case ID (UUID)'))
    .addStringOption(o => o.setName('note').setDescription('Optional note for audit/modlog').setMaxLength(512))
    .addBooleanOption(o => o.setName('silent').setDescription('Do not DM the user'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const warnNo = interaction.options.getInteger('warn_no');
    const caseId = interaction.options.getString('case_id');
    const note = interaction.options.getString('note') ?? null;
    const silent = interaction.options.getBoolean('silent') ?? false;

    // Require one identification method
    if (!warnNo && !caseId) {
      return safeReply(interaction, { 
        content: '❌ Please provide either `warn_no` or `case_id`.', 
        flags: MessageFlags.Ephemeral 
      });
    }

    // Validate case ID format if provided
    if (caseId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) {
      return safeReply(interaction, {
        content: '❌ Invalid case ID format. Must be a valid UUID.',
        flags: MessageFlags.Ephemeral
      });
    }

    // Fetch target member
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) {
      return safeReply(interaction, { 
        content: '❌ That user is not in this server.', 
        flags: MessageFlags.Ephemeral 
      });
    }

    // Check hierarchy
    const hier = checkHierarchy({ 
      guild: interaction.guild, 
      me: interaction.guild.members.me, 
      actor: interaction.member, 
      target 
    });
    if (!hier.ok) {
      return safeReply(interaction, { 
        content: humanizeError(hier.why), 
        flags: MessageFlags.Ephemeral 
      });
    }

    try {
      let resolvedCaseId = caseId;
      
      // Resolve warn number to case ID if needed
      if (!resolvedCaseId && warnNo) {
        const { rows } = await query(
          `SELECT id
           FROM infractions
           WHERE guild_id = $1
             AND user_id = $2
             AND type = 'warn'
             AND active = TRUE
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY created_at DESC
           OFFSET $3 LIMIT 1`,
          [interaction.guildId, target.id, Math.max(0, warnNo - 1)]
        );
        
        if (!rows.length) {
          return safeReply(interaction, { 
            content: `❌ No active warn #${warnNo} found for ${target.user.tag}.`, 
            flags: MessageFlags.Ephemeral 
          });
        }
        
        resolvedCaseId = rows[0].id;
      }

      // Revoke the warn
      const revoked = await revokeWarn({
        guildId: interaction.guildId,
        userId: target.id,
        caseId: resolvedCaseId,
        revokerId: interaction.user.id,
        revokeReason: note,
      });

      if (!revoked) {
        return safeReply(interaction, { 
          content: '❌ That warn is not active, does not exist, or belongs to a different user.', 
          flags: MessageFlags.Ephemeral 
        });
      }

      // Try to DM the user
      const { dm_on_action: dmOnAction } = await getGuildConfig(interaction.guildId, 'dm_on_action');
      let dmFailed = false;
      
      if (!silent && dmOnAction) {
        try {
          await target.send({
            content: `✅ **Your warning has been removed in ${interaction.guild.name}**\n` +
              `📋 **Case ID:** \`${revoked.id}\`\n` +
              `${note ? `📝 **Note:** ${note}` : ''}`
          });
        } catch (err) {
          dmFailed = true;
          await logAudit({
            guildId: interaction.guildId,
            actionType: 'dm_failed',
            actorId: interaction.user.id,
            targetId: target.id,
            details: { 
              action: 'unwarn', 
              error: err.message,
              caseId: revoked.id 
            },
          });
        }
      }

      // Log to mod log
      await emitModLog(interaction, {
        action: 'unwarn',
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetId: target.id,
        reason: note ?? undefined,
        ts: Date.now(),
        caseId: revoked.id,
        dmFailed,
      });

      // Audit log
      await logAudit({
        guildId: interaction.guildId,
        actionType: 'unwarn',
        actorId: interaction.user.id,
        targetId: target.id,
        details: { 
          caseId: revoked.id, 
          note,
          dmFailed,
        },
      });

      // Build response
      const response = [
        `${emojies.modAction} **Removed warning from ${target.user.tag}**`,
        `> ${emojies.voidEye} **Case ID:** \`${revoked.id}\``,
        note ? `> ${emojies.questionMark} **Note:** ${note}` : null,
        dmFailed ? `${emojies.error} *Could not DM user*` : null,
      ].filter(Boolean).join('\n');

      return safeReply(interaction, {
        content: response,
        flags: MessageFlags.Ephemeral,
      });
      
    } catch (err) {
      console.error('Unwarn command error:', err);
      return safeReply(interaction, {
        content: '❌ Failed to remove warning. Please try again or contact an administrator.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};