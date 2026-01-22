import { query, tx } from '../../core/db/index.js';
import { ensureGuildRow } from '../../core/db/guild.js';
import { createLogger, logger } from '../../core/logger.js';

const log = createLogger({ mod: 'mod-db' });

/**
 * Create an infraction and get the updated warn count atomically.
 * Prevents race conditions when multiple mods warn simultaneously.
 * @param {Object} params
 * @returns {Promise<{id: string, warnCount: number}>} The created infraction with current warn count
 */
export async function createInfractionWithCount({
  client, guildId, userId, moderatorId, type,
  reason = null, durationSeconds = null, context = {}
}) {
  const run = client ? client.query.bind(client) : query;

  // If your parseDuration returns ms upstream, make sure durationSeconds is seconds.
  const expiresAt =
    durationSeconds ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null;

  const sql = `
    WITH new_infraction AS (
      INSERT INTO infractions (
        guild_id, user_id, moderator_id, type, reason,
        duration_seconds, expires_at, context, created_at, active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),TRUE)
      RETURNING *
    ),
    decay_config AS (
      SELECT COALESCE(warn_decay_days, 30) AS decay_days
      FROM guild_config WHERE guild_id = $1
    ),
    matching_existing AS (
      SELECT 1
      FROM infractions i
      JOIN decay_config d ON TRUE
      WHERE i.guild_id = $1
        AND i.user_id  = $2
        AND i.type     = 'warn'
        AND i.active   = TRUE
        AND (i.expires_at IS NULL OR i.expires_at > NOW())
        AND (d.decay_days <= 0 OR i.created_at >= NOW() - (d.decay_days || ' days')::interval)
    ),
    matching_new AS (
      SELECT 1
      FROM new_infraction n
      JOIN decay_config d ON TRUE
      WHERE n.type   = 'warn'
        AND n.active = TRUE
        AND (n.expires_at IS NULL OR n.expires_at > NOW())
        AND (d.decay_days <= 0 OR n.created_at >= NOW() - (d.decay_days || ' days')::interval)
    ),
    warn_count AS (
      SELECT COUNT(*)::int AS total FROM (
        SELECT * FROM matching_existing
        UNION ALL
        SELECT * FROM matching_new
      ) x
    )
    SELECT n.*, wc.total AS warn_count
    FROM new_infraction n CROSS JOIN warn_count wc
  `;

  const params = [
    guildId, userId, moderatorId, type,
    reason, durationSeconds, expiresAt, JSON.stringify(context ?? {})
  ];

  const { rows: [r] } = await run(sql, params);

  return {
    id: r.id,
    guild_id: r.guild_id,
    user_id: r.user_id,
    moderator_id: r.moderator_id,
    type: r.type,
    reason: r.reason,
    duration_seconds: r.duration_seconds,
    expires_at: r.expires_at,
    created_at: r.created_at,
    active: r.active,
    context: r.context,
    warnCount: r.warn_count
  };
}


/**
 * Revoke a warn with proper validation.
 * @param {Object} params
 * @returns {Promise<Object|null>} The revoked infraction or null
 */
export async function revokeWarn({
  guildId,
  userId,
  caseId,
  revokerId,
  revokeReason = null,
}) {
  const queryText = `
    UPDATE infractions
    SET
      active = FALSE,
      revoked_at = NOW(),
      revoker_id = $4,
      reason = CASE
        WHEN ($5)::text IS NULL THEN reason
        ELSE CONCAT_WS(' | Revoke note: ', NULLIF(reason, ''), ($5)::text)
      END
    WHERE id = $1::uuid
      AND guild_id = $2::text
      AND user_id = $3::text
      AND type = 'warn'
      AND active = TRUE
    RETURNING *;
  `;

  const { rows: [revoked] } = await query(queryText, [
    caseId,
    guildId,
    userId,
    revokerId,
    revokeReason,     // may be null; the ::text cast above handles it
  ]);

  return revoked || null;
}


/**
 * Get active warn count with decay support.
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<number>} The active warn count
 */
export async function getActiveWarnCount(guildId, userId) {
  const queryText = `
    WITH config AS (
      SELECT COALESCE(warn_decay_days, 30) as decay_days
      FROM guild_config
      WHERE guild_id = $1
    )
    SELECT COUNT(*)::int AS count
    FROM infractions i, config c
    WHERE i.guild_id = $1
      AND i.user_id = $2
      AND i.type = 'warn'
      AND i.active = TRUE
      AND (i.expires_at IS NULL OR i.expires_at > NOW())
      AND (
        c.decay_days <= 0 
        OR i.created_at >= NOW() - INTERVAL '1 day' * c.decay_days
      )
  `;

  const { rows: [result] } = await query(queryText, [guildId, userId]);
  return result?.count || 0;
}

/**
 * Get user warns with proper sorting and limits.
 * @param {string} guildId
 * @param {string} userId
 * @param {number} limit
 * @returns {Promise<Array>} List of active warnings
 */
export async function getUserWarns(guildId, userId, limit = 25) {
  const queryText = `
    WITH config AS (
      SELECT COALESCE(warn_decay_days, 30) as decay_days
      FROM guild_config
      WHERE guild_id = $1
    )
    SELECT 
      i.id,
      i.moderator_id,
      i.reason,
      i.created_at,
      i.duration_seconds,
      i.expires_at,
      i.context
    FROM infractions i, config c
    WHERE i.guild_id = $1
      AND i.user_id = $2
      AND i.type = 'warn'
      AND i.active = TRUE
      AND (i.expires_at IS NULL OR i.expires_at > NOW())
      AND (
        c.decay_days <= 0 
        OR i.created_at >= NOW() - INTERVAL '1 day' * c.decay_days
      )
    ORDER BY i.created_at DESC
    LIMIT $3
  `;

  const { rows } = await query(queryText, [guildId, userId, limit]);
  return rows;
}

/**
 * Ensure guild config exists with defaults.
 * @param {string} guildId
 * @returns {Promise<void>}
 */
export async function ensureGuildConfig(guildId) {
  await query(
    `INSERT INTO guild_config (guild_id) 
     VALUES ($1) 
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}

/**
 * Get guild configuration safely.
 * @param {string} guildId
 * @param {string|Array<string>} keys - Specific keys to fetch
 * @returns {Promise<Object>} Guild config object
 */
export async function getGuildConfig(guildId, keys = []) {
  await ensureGuildConfig(guildId);
  
  const keysArray = Array.isArray(keys) ? keys : [keys];
  const validKeys = new Set([
    'dm_on_action', 'warn_decay_days', 'max_warns', 'mute_role_id',
    'log_channel_id', 'timeout_renewal', 'auto_mod_enabled',
    'spam_threshold', 'caps_threshold', 'invite_filter_enabled',
    'link_filter_enabled', 'profanity_filter_level'
  ]);
  
  const columns = keysArray.filter(k => validKeys.has(k));
  const selectClause = columns.length > 0 
    ? columns.map(c => `"${c}"`).join(', ')
    : '*';
    
  const { rows: [config] } = await query(
    `SELECT ${selectClause} FROM guild_config WHERE guild_id = $1`,
    [guildId]
  );
  
  // Return with defaults if not found
  return config || {
    dm_on_action: true,
    warn_decay_days: 30,
    max_warns: 3,
    timeout_renewal: true,
    auto_mod_enabled: true,
  };
}

/**
 * Get auto-action for a specific warn count.
 * @param {string} guildId
 * @param {number} warnCount
 * @returns {Promise<Object|null>} The action configuration or null
 */
export async function getAutoAction(guildId, warnCount) {
  // First check configured thresholds
  const { rows: [threshold] } = await query(
    `SELECT action, duration_seconds
     FROM warn_thresholds
     WHERE guild_id = $1 AND threshold <= $2
     ORDER BY threshold DESC
     LIMIT 1`,
    [guildId, warnCount]
  );
  
  if (threshold) return threshold;
  
  // Fall back to default max_warns
  const { max_warns } = await getGuildConfig(guildId, 'max_warns');
  if (max_warns && warnCount >= max_warns) {
    return { 
      action: 'timeout', 
      duration_seconds: 86400 // 24 hours default
    };
  }
  
  return null;
}

/**
 * Set or update a warn threshold.
 * @param {Object} params
 * @returns {Promise<Object>} The threshold configuration
 */
export async function setWarnThreshold({ 
  guildId, 
  threshold, 
  action, 
  durationSeconds = null 
}) {
  await ensureGuildConfig(guildId);
  
  const { rows: [row] } = await query(
    `INSERT INTO warn_thresholds (guild_id, threshold, action, duration_seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id, threshold) 
     DO UPDATE SET 
       action = EXCLUDED.action, 
       duration_seconds = EXCLUDED.duration_seconds
     RETURNING *`,
    [guildId, threshold, action, durationSeconds]
  );
  
  return row;
}

/**
 * List all warn thresholds for a guild.
 * @param {string} guildId
 * @returns {Promise<Array>} List of thresholds
 */
export async function listWarnThresholds(guildId) {
  await ensureGuildConfig(guildId);
  
  const { rows } = await query(
    `SELECT threshold, action, duration_seconds
     FROM warn_thresholds
     WHERE guild_id = $1
     ORDER BY threshold ASC`,
    [guildId]
  );
  
  return rows;
}

/**
 * Remove a warn threshold.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<boolean>} True if deleted
 */
export async function removeWarnThreshold(guildId, threshold) {
  const { rowCount } = await query(
    `DELETE FROM warn_thresholds 
     WHERE guild_id = $1 AND threshold = $2`,
    [guildId, threshold]
  );
  
  return rowCount > 0;
}

/**
 * Log an audit entry.
 * @param {Object} params
 * @returns {Promise<void>}
 */
export async function logAudit({ guildId, actionType, actorId, targetId, details }) {
  const insert = async (client) => client.query(
    `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details, timestamp)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [guildId, actionType, actorId ?? null, targetId ?? null, details ?? {}]
  );

  try {
    await tx(async (client) => {
      // Fast path: try insert first (cheap most of the time)
      await insert(client);
    });
  } catch (e) {
    // 23503 FK violation → missing guild_config row
    const isMissingGuild =
      e?.code === '23503' &&
      e?.constraint === 'audit_logs_guild_id_fkey';

    if (!isMissingGuild) throw e;

    // Ensure and retry once
    await ensureGuildRow(guildId);
    await tx(async (client) => { await insert(client); });
    log.debug({ guildId }, 'Recovered audit insert after ensureGuildRow');
  }
}

/**
 * Clear all active (non-expired, within decay window) warns for a user.
 * @param {Object} params
 * @returns {Promise<Array>} List of revoked infractions
 */
export async function clearUserWarns({
  guildId,
  userId,
  revokerId,
  clearReason = null,
}) {
  const sql = `
    WITH config AS (
      SELECT COALESCE(warn_decay_days, 30) AS decay_days
      FROM guild_config
      WHERE guild_id = $1
    ),
    affected AS (
      SELECT i.id
      FROM infractions i, config c
      WHERE i.guild_id = $1
        AND i.user_id  = $2
        AND i.type     = 'warn'
        AND i.active   = TRUE
        AND (i.expires_at IS NULL OR i.expires_at > NOW())
        AND (
          c.decay_days <= 0
          OR i.created_at >= NOW() - INTERVAL '1 day' * c.decay_days
        )
    ),
    updated AS (
      UPDATE infractions i
      SET
        active = FALSE,
        revoked_at = NOW(),
        revoker_id = $3,
        reason = CASE
          WHEN ($4)::text IS NULL THEN reason
          ELSE CONCAT_WS(' | Bulk clear: ', NULLIF(reason, ''), ($4)::text)
        END
      FROM affected a
      WHERE i.id = a.id
      RETURNING i.*
    )
    SELECT * FROM updated;
  `;

  const { rows } = await query(sql, [guildId, userId, revokerId, clearReason]);
  return rows;
}


// Export all functions
export default {
//  createInfraction,
  createInfractionWithCount,
  revokeWarn,
  getActiveWarnCount,
  getUserWarns,
  ensureGuildConfig,
  getGuildConfig,
  getAutoAction,
  setWarnThreshold,
  listWarnThresholds,
  removeWarnThreshold,
  logAudit,
  clearUserWarns
};