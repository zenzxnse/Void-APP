import { query, tx } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger({ mod: 'jobWorker' });

/**
 * Enqueue a scheduled job.
 * @param {Object} job
 * @returns {Promise<Object>} The created job
 */
export async function enqueue(job) {
  const { 
    type, 
    guild_id, 
    user_id = null, 
    channel_id = null,
    infraction_id = null, 
    run_at, 
    priority = 50,
    data = {}
  } = job;
  
  // Validate run_at is in the future
  const runAtDate = new Date(run_at);
  if (runAtDate <= new Date()) {
    log.warn({ run_at }, 'Enqueuing job with past run_at, setting to now + 1s');
    runAtDate.setSeconds(runAtDate.getSeconds() + 1);
  }
  
  const { rows: [created] } = await query(
    `INSERT INTO scheduled_jobs(type, guild_id, user_id, channel_id, infraction_id, run_at, priority, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [type, guild_id, user_id, channel_id, infraction_id, runAtDate, priority, JSON.stringify(data)]
  );
  
  log.info({ 
    jobId: created.id, 
    type: created.type,
    runAt: created.run_at 
  }, 'Job enqueued');
  
  return created;
}

export async function scheduleComponentCleanup(client) {
  // Schedule daily cleanup job
  await query(
    `INSERT INTO scheduled_jobs (
       type, guild_id, run_at, priority, data
     ) VALUES (
       'cleanup_components', 'system', 
       NOW() + INTERVAL '1 day', 10, '{}'
     ) ON CONFLICT DO NOTHING`
  );
}

/**
 * Process due jobs with proper locking.
 * FIXED: Using CTE for proper FOR UPDATE SKIP LOCKED
 * @param {import('discord.js').Client} client - Discord client for API operations
 * @param {string} workerId - Unique worker identifier
 * @param {number} limit - Max jobs to process in one batch
 * @returns {Promise<number>} Number of jobs processed
 */
export async function runDueJobs(client, workerId = 'bot-1', limit = 10) {
  // Acquire and lock jobs atomically using CTE
  const jobs = await tx(async (dbClient) => {
    const { rows } = await dbClient.query(`
      WITH pick AS (
        SELECT id
        FROM scheduled_jobs
        WHERE run_at <= NOW()
          AND attempts < 5
          AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '60 seconds')
        ORDER BY priority DESC, run_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE scheduled_jobs j
      SET locked_at = NOW(),
          locked_by = $2,
          attempts = attempts + 1
      FROM pick
      WHERE j.id = pick.id
      RETURNING j.*`, 
      [limit, workerId]
    );
    return rows;
  });

  if (jobs.length === 0) {
    return 0;
  }

  log.info({ count: jobs.length, workerId }, 'Processing jobs batch');

  let processed = 0;
  for (const job of jobs) {
    try {
      await handleJob(client, job);
      
      // Delete successful job
      await query(`DELETE FROM scheduled_jobs WHERE id = $1`, [job.id]);
      processed++;
      
      log.info({ 
        jobId: job.id, 
        type: job.type,
        userId: job.user_id,
        guildId: job.guild_id 
      }, 'Job completed successfully');
      
    } catch (err) {
      log.error({ 
        err, 
        jobId: job.id, 
        type: job.type,
        attempts: job.attempts 
      }, 'Job execution failed');
      
      // Update error and handle failure in one query
      // FIXED: Combined unlock and fail marking
      await query(
        `UPDATE scheduled_jobs 
         SET last_error = $2,
             locked_by = CASE WHEN attempts >= 5 THEN 'failed' ELSE NULL END,
             locked_at = CASE WHEN attempts >= 5 THEN NOW() ELSE NULL END
         WHERE id = $1`,
        [job.id, err.stack || String(err)]
      );
      
      if (job.attempts >= 5) {
        log.error({ 
          jobId: job.id, 
          type: job.type 
        }, 'Job failed permanently after 5 attempts');
      }
    }
  }

  return processed;
}

/**
 * Handle individual job execution.
 * @param {import('discord.js').Client} client
 * @param {Object} job
 */
async function handleJob(client, job) {
  const guild = await client.guilds.fetch(job.guild_id).catch(() => null);
  if (!guild) {
    throw new Error(`Guild ${job.guild_id} not found or bot removed`);
  }

  // Parse data if it's a string (backward compatibility)
  const jobData = typeof job.data === 'string' ? JSON.parse(job.data) : job.data;

  switch (job.type) {
    case 'unban': {
      if (!job.user_id) throw new Error('user_id required for unban job');
      
      // Check if user is actually banned
      const ban = await guild.bans.fetch(job.user_id).catch(() => null);
      if (!ban) {
        log.warn({ 
          userId: job.user_id, 
          guildId: job.guild_id 
        }, 'User not banned, skipping unban');
        return;
      }
      
      // Unban the user
      await guild.bans.remove(
        job.user_id, 
        `Temporary ban expired (Job #${job.id})`
      );
      
      // Log to audit with worker ID
      await logJobCompletion(job, 'User unbanned after temporary ban', job.locked_by);
      
      // Try to notify user (if we have DM capability)
      const user = await client.users.fetch(job.user_id).catch(() => null);
      if (user) {
        await user.send(
          `Your temporary ban from **${guild.name}** has expired. You may now rejoin the server.`
        ).catch((err) => {
          log.debug({ userId: job.user_id, error: err.message }, 'Could not DM user about unban');
        });
      }
      
      break;
    }

    case 'untimeout': {
      if (!job.user_id) throw new Error('user_id required for untimeout job');
      
      const member = await guild.members.fetch(job.user_id).catch(() => null);
      if (!member) {
        log.warn({ 
          userId: job.user_id, 
          guildId: job.guild_id 
        }, 'Member not found for untimeout');
        return;
      }
      
      // Remove timeout (set to null)
      await member.timeout(null, `Timeout expired (Job #${job.id})`);
      
      await logJobCompletion(job, 'Timeout removed after duration', job.locked_by);
      break;
    }

    case 'unmute': {
      if (!job.user_id) throw new Error('user_id required for unmute job');
      
      const member = await guild.members.fetch(job.user_id).catch(() => null);
      if (!member) {
        log.warn({ 
          userId: job.user_id, 
          guildId: job.guild_id 
        }, 'Member not found for unmute');
        return;
      }
      
      // Gets mute role from guild config
      const { rows: [config] } = await query(
        `SELECT mute_role_id FROM guild_config WHERE guild_id = $1`,
        [job.guild_id]
      );
      
      if (!config?.mute_role_id) {
        throw new Error('Mute role not configured for guild');
      }
      
      const muteRole = guild.roles.cache.get(config.mute_role_id);
      if (!muteRole) {
        throw new Error('Mute role not found in guild');
      }
      
      // This removes mute role remember bro
      await member.roles.remove(
        muteRole, 
        `Mute expired (Job #${job.id})`
      );
      
      await logJobCompletion(job, 'Mute role removed after duration', job.locked_by);
      break;
    }

    case 'reapply_timeout': {
      if (!job.user_id) throw new Error('user_id required for reapply_timeout job');
      
      const member = await guild.members.fetch(job.user_id).catch(() => null);
      if (!member) {
        log.warn({ 
          userId: job.user_id, 
          guildId: job.guild_id 
        }, 'Member not found for timeout reapplication');
        return;
      }
      
      // Check if there's still remaining duration
      const remainingMs = jobData?.remainingMs || 28 * 24 * 60 * 60 * 1000;
      const maxTimeout = 28 * 24 * 60 * 60 * 1000;
      const applyMs = Math.min(remainingMs, maxTimeout);
      
      // Reapply timeout
      await member.timeout(
        applyMs, 
        `Timeout renewal (Job #${job.id})`
      );
      
      // Schedule next renewal if needed
      if (remainingMs > maxTimeout) {
        const nextRunAt = new Date(Date.now() + maxTimeout - 60000); // 1 min before expiry
        await enqueue({
          type: 'reapply_timeout',
          guild_id: job.guild_id,
          user_id: job.user_id,
          infraction_id: job.infraction_id,
          run_at: nextRunAt,
          priority: 70, // Higher priority for renewals
          data: { remainingMs: remainingMs - maxTimeout }
        });
      }
      
      await logJobCompletion(job, 'Timeout reapplied for extended duration', job.locked_by);
      break;
    }

    case 'cleanup_expired': {
      // Clean up expired infractions
      const { rowCount } = await query(
        `UPDATE infractions 
         SET active = FALSE 
         WHERE guild_id = $1 
           AND active = TRUE 
           AND expires_at IS NOT NULL 
           AND expires_at <= NOW()`,
        [job.guild_id]
      );
      
      log.info({ 
        guildId: job.guild_id, 
        deactivated: rowCount 
      }, 'Cleaned up expired infractions');
      
      await logJobCompletion(job, `Deactivated ${rowCount} expired infractions`, job.locked_by);
      break;
    }

    case 'slowmode_end': {
      if (!job.channel_id) throw new Error('channel_id required for slowmode_end job');
      
      const channel = await guild.channels.fetch(job.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        log.warn({ 
          channelId: job.channel_id, 
          guildId: job.guild_id 
        }, 'Channel not found or not text-based');
        return;
      }
      
      // FIXED: Check if method exists
      if (typeof channel.setRateLimitPerUser !== 'function') {
        log.warn({ channelId: job.channel_id }, 'Channel does not support slowmode');
        return;
      }
      
      // Remove slowmode
      await channel.setRateLimitPerUser(0, `Slowmode expired (Job #${job.id})`);
      
      await logJobCompletion(job, 'Slowmode removed after duration', job.locked_by);
      break;
    }

    case 'lockdown_end': {
      if (!job.channel_id) throw new Error('channel_id required for lockdown_end job');
      
      const channel = await guild.channels.fetch(job.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        log.warn({ 
          channelId: job.channel_id, 
          guildId: job.guild_id 
        }, 'Channel not found or not text-based');
        return;
      }
      
      // FIXED: Check if permissionOverwrites exists
      if (!channel.permissionOverwrites) {
        log.warn({ channelId: job.channel_id }, 'Channel does not support permission overwrites');
        return;
      }
      
      // Remove lockdown (allow SendMessages for @everyone)
      const everyone = guild.roles.everyone;
      await channel.permissionOverwrites.edit(
        everyone, 
        { SendMessages: null }, 
        { reason: `Lockdown expired (Job #${job.id})` }
      );
      
      await logJobCompletion(job, 'Channel lockdown removed after duration', job.locked_by);
      break;
    }
    case 'cleanup_components': {
      await query('SELECT cleanup_expired_components()');
      
      // Reschedule for tomorrow
      await scheduleComponentCleanup(client);
      break;
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

/**
 * Log job completion to audit_logs.
 * FIXED: Stringify the details object
 * @param {Object} job
 * @param {string} message
 * @param {string} actor - Worker ID or 'system'
 */
async function logJobCompletion(job, message, actor = 'system') {
  await query(
    `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details, timestamp)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      job.guild_id,
      `job_${job.type}`,
      actor,
      job.user_id || job.channel_id,
      JSON.stringify({
        jobId: job.id,
        type: job.type,
        message,
        infractionId: job.infraction_id,
        attempts: job.attempts
      })
    ]
  );
}

/**
 * Clean up old completed/failed jobs.
 * @param {number} daysOld - Delete jobs older than this many days
 * @returns {Promise<number>} Number of jobs deleted
 */
export async function cleanupOldJobs(daysOld = 30) {
  const { rowCount } = await query(
    `DELETE FROM scheduled_jobs 
     WHERE (
       locked_by = 'failed' 
       OR (run_at < NOW() - INTERVAL '1 day' * $1 AND attempts >= 5)
       OR (locked_at < NOW() - INTERVAL '1 day' * $1 AND locked_at IS NOT NULL)
     )`,
    [daysOld]
  );
  
  if (rowCount > 0) {
    log.info({ deleted: rowCount, daysOld }, 'Cleaned up old jobs');
  }
  
  return rowCount;
}

/**
 * Get job statistics.
 * @param {string} guildId - Optional guild filter
 * @returns {Promise<Object>} Job stats
 */
export async function getJobStats(guildId = null) {
  const guildFilter = guildId ? 'WHERE guild_id = $1' : '';
  const params = guildId ? [guildId] : [];
  
  const { rows: [stats] } = await query(
    `SELECT 
       COUNT(*) FILTER (WHERE locked_at IS NULL AND locked_by IS NULL) as pending,
       COUNT(*) FILTER (WHERE locked_at IS NOT NULL AND locked_by != 'failed') as processing,
       COUNT(*) FILTER (WHERE locked_by = 'failed') as failed,
       COUNT(*) FILTER (WHERE attempts > 0 AND attempts < 5 AND locked_at IS NULL) as retrying,
       COUNT(*) as total
     FROM scheduled_jobs
     ${guildFilter}`,
    params
  );
  
  return stats;
}

export default {
  enqueue,
  runDueJobs,
  cleanupOldJobs,
  getJobStats
};