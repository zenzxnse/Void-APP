import {
  PermissionFlagsBits,
  AuditLogEvent,
} from 'discord.js';
import { createInfractionWithCount, ensureGuildConfig, getGuildConfig, logAudit } from './mod-db.js';
import pool from '../../core/db/index.js'; // For scheduling

/**
 * Apply a moderation action to a target member.
 * @param {Object} params - {guild, target, actorId, action, durationSeconds?, reason, context?, isAuto=false}
 * @returns {Promise<{applied: boolean, infraction: Object, msg: string}>} Result.
 */
export async function applyModAction({ guild, target, actorId, action, durationSeconds = null, reason = '', context = {}, isAuto = false }) {
  await ensureGuildConfig(guild.id);
  const botMember = guild.members.me;
  let applied = false;
  let errorMsg = '';
  const autoPrefix = isAuto ? 'Auto-' : '';

  // Base reason
  reason = `${autoPrefix}${action}${reason ? `: ${reason}` : ''}`;

  // Check bot permissions
  if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    errorMsg = 'Bot lacks Moderate Members permission.';
    return { applied: false, infraction: null, msg: errorMsg };
  }

  try {
    switch (action) {
      case 'timeout': {
        if (!durationSeconds) throw new Error('Duration required for timeout.');
        const maxTimeout = 28 * 24 * 60 * 60 * 1000; // 28 days ms
        let effectiveDuration = durationSeconds * 1000;
        const { timeout_renewal } = await getGuildConfig(guild.id, 'timeout_renewal');
        if (effectiveDuration > maxTimeout && timeout_renewal) {
          // Apply max, schedule renewal
          await target.timeout(maxTimeout, reason);
          // Schedule reapply
          await scheduleJob({
            guildId: guild.id,
            type: 'reapply_timeout',
            userId: target.id,
            runAt: new Date(Date.now() + maxTimeout).toISOString(),
            // Store remaining in context or separate
          });
          // For full duration, schedule untimeout at end
          await scheduleJob({
            guildId: guild.id,
            type: 'untimeout',
            userId: target.id,
            runAt: new Date(Date.now() + effectiveDuration).toISOString(),
          });
        } else {
          effectiveDuration = Math.min(effectiveDuration, maxTimeout);
          await target.timeout(effectiveDuration, reason);
          // Schedule untimeout if <28d
          if (effectiveDuration < maxTimeout) {
            await scheduleJob({
              guildId: guild.id,
              type: 'untimeout',
              userId: target.id,
              runAt: new Date(Date.now() + effectiveDuration).toISOString(),
            });
          }
        }
        applied = true;
        break;
      }
      case 'mute': {
        const { mute_role_id } = await getGuildConfig(guild.id, 'mute_role_id');
        if (!mute_role_id) throw new Error('Mute role not configured.');
        const muteRole = await guild.roles.fetch(mute_role_id);
        if (!muteRole) throw new Error('Mute role not found.');
        await target.roles.add(muteRole, reason);
        if (durationSeconds) {
          await scheduleJob({
            guildId: guild.id,
            type: 'unmute',
            userId: target.id,
            runAt: new Date(Date.now() + durationSeconds * 1000).toISOString(),
          });
        }
        applied = true;
        break;
      }
      case 'kick': {
        await target.kick(reason);
        applied = true;
        break;
      }
      case 'ban':
      case 'softban': {
        const deleteDays = action === 'softban' ? 7 : 0; // Softban deletes recent msgs
        await target.ban({ reason, deleteMessageSeconds: deleteDays * 86400 });
        if (action === 'softban' || (action === 'ban' && durationSeconds)) {
          // For softban, immediate unban; for temp ban, schedule unban
          const unbanDelay = action === 'softban' ? 1000 : durationSeconds * 1000; // 1s for soft
          setTimeout(async () => {
            await guild.bans.remove(target.id, `Auto-unban after ${action}`);
          }, unbanDelay);
          // Or use scheduleJob for 'unban'
          await scheduleJob({
            guildId: guild.id,
            type: 'unban',
            userId: target.id,
            runAt: new Date(Date.now() + unbanDelay).toISOString(),
          });
        }
        applied = true;
        break;
      }
      case 'none':
        applied = true; // No-op
        break;
      default:
        errorMsg = `Unknown action: ${action}`;
    }
  } catch (err) {
    errorMsg = `Failed to apply ${action}: ${err.message}`;
  }

  // Create infraction regardless (for audit)
  const infraction = await createInfractionWithCount({
    guildId: guild.id,
    userId: target.id,
    moderatorId: isAuto ? botMember.id : actorId,
    type: action,
    reason,
    durationSeconds,
    context: { ...context, isAuto },
  });

  // Log audit
  await logAudit({
    guildId: guild.id,
    actionType: `${autoPrefix}${action}`,
    actorId: actorId,
    targetId: target.id,
    details: { reason, durationSeconds, success: applied, error: errorMsg },
  });

  const msg = applied ? `${autoPrefix}${action} applied successfully.` : errorMsg;
  return { applied, infraction, msg };
}

/**
 * Schedule a job in the DB (worker not implemented here; assume separate process).
 * @param {Object} params - {guildId, type, userId, infractionId?, runAt, priority?}
 */
async function scheduleJob({ guildId, type, userId, infractionId = null, runAt, priority = 50 }) {
  await pool.query(
    `INSERT INTO scheduled_jobs (type, guild_id, user_id, infraction_id, run_at, priority)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [type, guildId, userId, infractionId, runAt, priority],
  );
}

// TODO: Implement a worker to process scheduled_jobs periodically, e.g., in bot ready event or separate script.
// For example, query jobs where run_at <= now() and locked_at is null, lock, execute, update.