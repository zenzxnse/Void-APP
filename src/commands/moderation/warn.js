import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
} from 'discord.js';
import {
  ensureInGuild, normalizeReason, checkHierarchy,
  safeReply, emitModLog, humanizeError,
} from '../../utils/moderation/mod.js';
import {
  createInfractionWithCount, getAutoAction, getGuildConfig, logAudit,
} from '../../utils/moderation/mod-db.js';
import { parseDurationSeconds, prettySecs } from '../../utils/moderation/duration.js';
import { applyModAction } from '../../utils/moderation/mod-actions.js';
import { tx } from '../../core/db/index.js';

// Rate limiting map: `${guildId}:${modId}:${targetId}` -> timestamp
const warnRateLimit = new Map();
const RATE_LIMIT_MS = 5000; // 5 seconds between warns for same target by same mod

export default {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member.')
    .addUserOption(o => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the warn').setMaxLength(1024))
    .addStringOption(o => o.setName('duration').setDescription('How long this warn stays active (e.g. 7d, 12h, 45m)'))
    .addBooleanOption(o => o.setName('silent').setDescription('Do not DM the user'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const reason = normalizeReason(interaction.options.getString('reason'));
    const silent = interaction.options.getBoolean('silent') ?? false;
    const durationStr = interaction.options.getString('duration');

    // Validate duration if provided
    let durationSeconds = null;

    if (durationStr) {
        const seconds = parseDurationSeconds(durationStr);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return safeReply(interaction, { content: '❌ Invalid duration.', flags: MessageFlags.Ephemeral });
        }
        const MAX_WARN_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days
        if (seconds > MAX_WARN_DURATION_SECONDS) {
          return safeReply(interaction, { content: '❌ Duration cannot exceed 90 days.', flags: MessageFlags.Ephemeral });
        }
        durationSeconds = seconds; // <- stay in seconds
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

    // Rate limiting check
    const rateLimitKey = `${interaction.guildId}:${interaction.user.id}:${target.id}`;
    const lastWarn = warnRateLimit.get(rateLimitKey);
    const now = Date.now();
    
    if (lastWarn && now - lastWarn < RATE_LIMIT_MS) {
      const remaining = Math.ceil((RATE_LIMIT_MS - (now - lastWarn)) / 1000);
      return safeReply(interaction, {
        content: `⏳ Please wait ${remaining} seconds before warning this user again.`,
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      // Use transaction for atomic warn creation and count
      const result = await tx(async (client) => {
        // Create infraction and get count atomically
        const infraction = await createInfractionWithCount({
          client,
          guildId: interaction.guildId,
          userId: target.id,
          moderatorId: interaction.user.id,
          type: 'warn',
          reason,
          durationSeconds,
        });

        // Check for auto-action
        const autoAction = await getAutoAction(interaction.guildId, infraction.warnCount);
        
        return { infraction, autoAction };
      });

      const { infraction, autoAction } = result;
      warnRateLimit.set(rateLimitKey, now);

      // Clean up old rate limit entries periodically
      if (warnRateLimit.size > 100) {
        for (const [key, time] of warnRateLimit) {
          if (now - time > RATE_LIMIT_MS * 2) {
            warnRateLimit.delete(key);
          }
        }
      }

      // Handle auto-action if configured
      let autoMsg = '';
      let autoInfraction = null;
      
      if (autoAction && autoAction.action !== 'none') {
        try {
          const { applied, infraction: autoInf, msg } = await applyModAction({
            guild: interaction.guild,
            target,
            actorId: interaction.user.id,
            action: autoAction.action,
            durationSeconds: autoAction.duration_seconds,
            reason: `Auto-escalation after ${infraction.warnCount} warns${reason ? `: ${reason}` : ''}`,
            context: { fromWarnId: infraction.id },
            isAuto: true,
          });
          
          if (applied) {
            const duration = autoAction.duration_seconds 
              ? ` for ${prettySecs(autoAction.duration_seconds)}` 
              : '';
            autoMsg = `\n🔨 **Auto-action triggered:** ${autoAction.action}${duration}`;
            autoInfraction = autoInf;
            
            // Update warn with replacement
            if (autoInf) {
              await tx(async (client) => {
                await client.query(
                  `UPDATE infractions SET replaced_by = $1 WHERE id = $2`,
                  [autoInf.id, infraction.id]
                );
              });
            }
          } else {
            autoMsg = `\n⚠️ Auto-action failed: ${msg}`;
          }
        } catch (err) {
          console.error('Auto-action error:', err);
          autoMsg = '\n⚠️ Auto-action failed due to an error.';
        }
      }

      // Try to DM the user
      const { dm_on_action: dmOnAction } = await getGuildConfig(interaction.guildId, 'dm_on_action');
      let dmFailed = false;
      
      if (!silent && dmOnAction) {
        try {
          await target.send({
            content: `⚠️ **You received a warning in ${interaction.guild.name}**\n` +
              `${reason ? `📝 **Reason:** ${reason}\n` : ''}` +
              `📋 **Case ID:** \`${infraction.id}\`\n` +
              `⚠️ **Total warnings:** ${infraction.warnCount}` +
              `${autoMsg ? `\n${autoMsg}` : ''}`
          });
        } catch (err) {
          dmFailed = true;
          await logAudit({
            guildId: interaction.guildId,
            actionType: 'dm_failed',
            actorId: interaction.user.id,
            targetId: target.id,
            details: { 
              action: 'warn', 
              error: err.message,
              caseId: infraction.id 
            },
          });
        }
      }

      // Log to mod log
      await emitModLog(interaction, {
        action: 'warn',
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
        actionType: 'warn',
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
        `✅ **Warned ${target.user.tag}**`,
        `📋 **Case ID:** \`${infraction.id}\``,
        `⚠️ **Total warnings:** ${infraction.warnCount}`,
        reason ? `📝 **Reason:** ${reason}` : null,
        durationSeconds ? `⏱️ **Duration:** ${prettySecs(durationSeconds)}` : null,
        autoMsg || null,
        dmFailed ? '⚠️ *Could not DM user*' : null,
      ].filter(Boolean).join('\n');

      return safeReply(interaction, {
        content: response,
        flags: MessageFlags.Ephemeral,
      });
      
    } catch (err) {
      console.error('Warn command error:', err);
      return safeReply(interaction, {
        content: '❌ Failed to issue warning. Please try again or contact an administrator.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};