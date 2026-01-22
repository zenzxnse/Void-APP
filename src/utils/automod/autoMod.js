// src/utils/automod/automod.js
import {
  Events,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  Collection,
} from 'discord.js';
import pLimit from 'p-limit';

import { query, tx } from '../../core/db/index.js';
import { createLogger } from '../../core/logger.js';
import { createInfractionWithCount, getGuildConfig } from '../moderation/mod-db.js';
import { applyModAction } from '../moderation/mod-actions.js';
import { createAutoModState, getAutoModState } from './redis-state.js';

const log = createLogger({ mod: 'automod:handle' });

// ------------------------------
// Tunables
// ------------------------------
const dbLimit = pLimit(50);
const MAX_REGEX_LENGTH = 200;
const REGEX_TIMEOUT_MS = 100;
const ACTION_LOCK_TTL = 15;            // seconds, per (guild,user,action)
const VIOLATION_COOLDOWN_S = 10;       // seconds, per (guild,user,ruleType) across shards
const FETCH_PAGE_DELAY_MS = 120;       // delay between fetch pages
const FETCH_PAGES_MAX = 5;             // up to 5 x 100 messages per violation
const BULK_DELETE_CAP = 80;            // max targeted deletions per burst (<=100)
const VALID_ACTIONS = new Set(['delete', 'warn', 'timeout', 'mute', 'kick', 'ban']);

// ------------------------------
// Public Facade
// ------------------------------
export const Automod = {
  /**
   * Call ONCE at startup.
   * @param {{ redisClient: any }} opts
   */
  start(opts) {
    if (!opts?.redisClient) throw new Error('Automod.start requires { redisClient }');
    createAutoModState(opts.redisClient); // singleton init + background cleanup
    log.info('AutoMod initialized');
  },

  /**
   * @param {import('discord.js').Message} message
   * @param {import('discord.js').Client} client
   * @returns {Promise<{acted:boolean, results?:any[]}|undefined>}
   */
  async handle(message, client) {
    try {
      if (message.system || !message.inGuild()) return { acted: false, reason: 'skip' };
      if (!message.content?.trim() && message.attachments.size === 0) return { acted: false, reason: 'empty' };

      if (!message.member) {
        try { message.member = await message.guild.members.fetch(message.author.id); }
        catch { return { acted: false, reason: 'no_member' }; }
      }

      const state = getAutoModState();
      const config = await dbLimit(() => getGuildAutoModConfig(message.guildId, state));
      if (!config?.enabled || !config.rules?.length) return { acted: false, reason: 'disabled' };

      if (await isExempt(message, config.rules)) return { acted: false, reason: 'exempt' };

      const tracking = await Promise.allSettled([
        state.trackMessage(message.author.id, message.guildId),
        (message.mentions.users.size + message.mentions.roles.size) > 0
          ? state.trackMentions(message.author.id, message.guildId, message.mentions.users.size + message.mentions.roles.size)
          : Promise.resolve(),
        state.trackChannelUsage(message.author.id, message.guildId, message.channelId)
      ]);
      if (tracking.filter(r => r.status === 'rejected').length > tracking.length / 2) {
        log.warn({ guildId: message.guildId }, 'Skipping automod due to tracking failures');
        return { acted: false, reason: 'tracking_fail' };
      }

      for (const rule of config.rules) {
        if (!rule.enabled || rule.quarantined) continue;

        let violation = null;
        try {
          violation = await checkRule(message, rule, state);
        } catch (err) {
          log.error({ err, ruleId: rule.id, type: rule.type }, 'Rule checker error');
          continue;
        }
        if (!violation) continue;

        const violKey = `viol:${rule.type}:${rule.id}`;
        const isFirst = await state.acquireActionLock(message.guildId, message.author.id, violKey, VIOLATION_COOLDOWN_S);
        if (!isFirst) {
          const hasDelete = getRuleActions(rule).some(a => normalizeAction(a) === 'delete');
          if (hasDelete && message.deletable) message.delete().catch(() => {});
          return { acted: true, results: [{ action: 'delete?cooldown', success: hasDelete }] };
        }

        try {
          const results = await handleViolation(message, rule, violation, state, client);
          if (results.some(r => r.success)) {
            await postViolationEmbed(message, rule, violation, results);
          }
          return { acted: results.some(r => r.success), results };
        } catch (err) {
          log.error({ err, ruleId: rule.id }, 'Violation handling failed');
          return { acted: false, reason: 'handler_error' };
        }
      }

      return { acted: false, reason: 'no_match' };
    } catch (err) {
      log.error({ err }, 'Automod.handle error');
      return { acted: false, reason: 'error' };
    }
  }
};

// ------------------------------
// Helpers
// ------------------------------
function normalizeAction(action) {
  const s = String(action).toLowerCase().trim();
  if (s === 'mute') return 'timeout'; // map legacy
  return VALID_ACTIONS.has(s) ? s : null;
}

function getRuleActions(rule) {
  const data = typeof rule.rule_data === 'object' ? rule.rule_data : {};
  const list = Array.isArray(data.actions) ? data.actions : [];
  if (list.length) {
    return [...new Set(list.map(a => String(a).toLowerCase().trim()).filter(Boolean))];
  }
  return [String(rule.action || 'delete').toLowerCase().trim()];
}

async function handleViolation(message, rule, violation, state, client) {
  const actions = getRuleActions(rule);
  const results = [];
  let deletedCountForDm = 0;
  let warned = false;

  for (const raw of actions) {
    const action = normalizeAction(raw);
    if (!action) {
      results.push({ action: raw, success: false, error: 'invalid_action' });
      continue;
    }

    if (action === 'delete') {
      const deleted = await deleteBurstFromUser(message, rule, violation);
      deletedCountForDm += deleted;
      results.push({ action: 'delete', success: deleted > 0, deleted });
      continue;
    }

    // lock for stateful actions
    const haveLock = await state.acquireActionLock(
      message.guildId, message.author.id, action, ACTION_LOCK_TTL
    );
    if (!haveLock) {
      results.push({ action, success: false, skipped: true, error: 'locked' });
      continue;
    }

    try {
      if (action === 'warn') {
        const infr = await createInfractionWithCount({
          guildId: message.guildId,
          userId: message.author.id,
          moderatorId: client.user.id,
          type: 'warn',
          reason: `AutoMod: ${rule.name} - ${reasonFromViolation(violation)}`,
          durationSeconds: null,
          context: {
            autoMod: true,
            ruleId: rule.id,
            ruleName: rule.name,
            violation: violation.details,
            messageId: message.id,
            channelId: message.channelId
          }
        });

        await recordAction(message, rule, violation, 'warn', true, null, infr.id);
        warned = true;
        results.push({ action: 'warn', success: true, infractionId: infr.id });
      } else {
        const res = await applyModAction({
          guild: message.guild,
          target: message.member,
          actorId: client.user.id,
          action, // timeout | kick | ban
          durationSeconds:
            rule.duration_seconds ??
            rule.rule_data?.duration_seconds ??
            (action === 'timeout' ? 300 : null),
          reason: `AutoMod: ${rule.name} - ${reasonFromViolation(violation)}`,
          context: {
            autoMod: true,
            ruleId: rule.id,
            ruleName: rule.name,
            violation: violation.details,
            messageId: message.id,
            channelId: message.channelId
          },
          isAuto: true
        });

        await recordAction(
          message, rule, violation, action, !!res.applied, res.applied ? null : (res.msg || 'failed'),
          res.infraction?.id
        );

        results.push({
          action,
          success: !!res.applied,
          infractionId: res.infraction?.id,
          error: res.applied ? null : (res.msg || 'failed')
        });
      }
    } catch (err) {
      await recordAction(message, rule, violation, action, false, err.message);
      results.push({ action, success: false, error: err.message });
    } finally {
      await state.releaseActionLock(message.guildId, message.author.id, action);
    }
  }

  // DM violator if something succeeded and DM is enabled
  const shouldDm = results.some(r => r.success) && (await getDmFlag(message.guildId));
  if (shouldDm) {
    try {
      const actionList = results
        .filter(r => r.success)
        .map(r => (r.action === 'delete' && r.deleted > 1 ? `DELETE (${r.deleted})` : r.action.toUpperCase()))
        .join(' + ');

      const emb = new EmbedBuilder()
        .setTitle('🛡️ Auto-Moderation Notice')
        .setColor(0xffa500)
        .setDescription(
          [
            `Action taken in **${message.guild.name}**`,
            `**Rule:** ${rule.name}`,
            `**Actions:** ${actionList}`,
            // optional: include warn count if your createInfractionWithCount returns it
          ].filter(Boolean).join('\n')
        )
        .setFooter({ text: `Reason: ${reasonFromViolation(violation)}` })
        .setTimestamp();

      if (violation.type === 'spam' && violation.details?.messageCount) {
        emb.addFields({ name: 'Details', value: `${violation.details.messageCount} messages in ${violation.details.timeWindow}s`, inline: false });
      }
      const deletedSum = results.find(r => r.action === 'delete')?.deleted || 0;
      if (deletedSum > 0) {
        emb.addFields({ name: 'Messages Removed', value: String(deletedSum), inline: true });
      }

      await message.author.send({ embeds: [emb] }).catch(() => {});
    } catch {}
  }

  return results;
}

async function getDmFlag(guildId) {
  try {
    const { dm_on_action } = await getGuildConfig(guildId, 'dm_on_action');
    return !!dm_on_action;
  } catch {
    return true;
  }
}

// Record one row per action into automod_violations + audit
async function recordAction(message, rule, violation, action, success, errorMsg = null, infractionId = null) {
  await tx(async (client) => {
    await client.query(
      `INSERT INTO automod_violations
         (guild_id, user_id, rule_id, message_id, channel_id,
          violation_type, action_taken, violation_data, success, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        message.guildId, message.author.id, rule.id,
        message.id, message.channelId,
        violation.type, action,
        JSON.stringify(violation.details || {}),
        success, errorMsg
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        message.guildId,
        'automod_violation',
        message.client.user.id,
        message.author.id,
        JSON.stringify({
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.type,
          action,
          success,
          error: errorMsg,
          infractionId,
          messageId: message.id,
          channelId: message.channelId,
          ts: Date.now()
        })
      ]
    );
  });
}

// ------------------------------
// Cleaning logic
// ------------------------------
async function deleteBurstFromUser(message, rule, violation) {
  const chan = message.channel;
  if (!chan || chan.type !== ChannelType.GuildText) return 0;

  const winS = ((rule.rule_data?.window_seconds || rule.duration_seconds) || 5);
  const cutoff = Date.now() - winS * 1000;

  const toDelete = [];
  let before;

  for (let page = 0; page < FETCH_PAGES_MAX && toDelete.length < BULK_DELETE_CAP; page++) {
    const batch = await chan.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;

    for (const msg of batch.values()) {
      if (msg.author.id !== message.author.id) continue;
      if (msg.createdTimestamp < cutoff) break;
      if (!msg.pinned && msg.deletable) toDelete.push(msg);
      if (toDelete.length >= BULK_DELETE_CAP) break;
    }

    before = batch.lastKey();
    if (!before) break;
    await new Promise(r => setTimeout(r, FETCH_PAGE_DELAY_MS));
  }

  if (message.deletable && !toDelete.some(m => m.id === message.id)) {
    toDelete.unshift(message);
  }

  if (toDelete.length === 0) return 0;

  const coll = new Collection();
  for (const m of toDelete) coll.set(m.id, m);

  const res = await chan.bulkDelete(coll, true).catch(() => null);
  if (res?.size) return res.size;

  let count = 0;
  for (const m of toDelete) {
    try { await m.delete(); count++; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return count;
}

// ------------------------------
// Embeds
// ------------------------------
async function postViolationEmbed(message, rule, violation, results) {
  try {
    const chan = message.channel;
    if (!chan || chan.type !== ChannelType.GuildText) return;

    const perms = chan.permissionsFor(message.guild.members.me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) ||
        !perms?.has(PermissionFlagsBits.EmbedLinks)) return;

    const ok = results.filter(r => r.success);
    const failed = results.filter(r => !r.success && !r.skipped);
    if (!ok.length) return;

    const actionsStr = ok.map(r => {
      if (r.action === 'delete' && typeof r.deleted === 'number' && r.deleted > 1) {
        return `DELETE (${r.deleted})`;
      }
      return r.action.toUpperCase();
    }).join(' + ');

    const emb = new EmbedBuilder()
      .setTitle('🛡️ Auto-Moderation Violation')
      .setColor(0xff6b6b)
      .addFields(
        { name: 'User', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
        { name: 'Rule', value: rule.name, inline: true },
        { name: 'Actions', value: actionsStr || '—', inline: true }
      )
      .setFooter({ text: `Reason: ${reasonFromViolation(violation)}` })
      .setTimestamp();

    if (violation.type === 'spam' && violation.details?.messageCount) {
      emb.addFields({
        name: 'Details',
        value: `${violation.details.messageCount} messages in ${violation.details.timeWindow}s`,
        inline: false
      });
    }
    if (failed.length) {
      emb.addFields({ name: 'Failed', value: failed.map(f => f.action.toUpperCase()).join(', '), inline: false });
    }

    await chan.send({ embeds: [emb] });
  } catch (err) {
    log.debug({ err, channelId: message.channel?.id }, 'Failed to post violation embed');
  }
}

// ------------------------------
// Config & exemptions
// ------------------------------
async function getGuildAutoModConfig(guildId, state) {
  const cached = await state.getGuildConfig(guildId);
  if (cached && Date.now() < cached.expires) {
    cached.rules?.forEach(r => {
      if (typeof r.rule_data === 'string') {
        try { r.rule_data = JSON.parse(r.rule_data); } catch { r.rule_data = {}; }
      }
    });
    return cached;
  }

  try {
    const [cfg, rules] = await Promise.all([
      query(`SELECT auto_mod_enabled FROM guild_config WHERE guild_id = $1`, [guildId]),
      query(`
        SELECT id, name, type, pattern, action, threshold, duration_seconds,
               exempt_roles, exempt_channels, enabled, quarantined,
               rule_data, priority, created_at
          FROM auto_mod_rules
         WHERE guild_id = $1 AND enabled = TRUE AND quarantined = FALSE
         ORDER BY COALESCE(priority,50) DESC, created_at ASC
      `, [guildId])
    ]);

    const cooked = rules.rows.map(r => ({
      ...r,
      rule_data: typeof r.rule_data === 'string' ? safelyParseJSON(r.rule_data) : (r.rule_data || {})
    }));

    const config = {
      enabled: cfg.rows[0]?.auto_mod_enabled ?? false,
      rules: cooked,
      expires: Date.now() + 5 * 60 * 1000
    };

    await state.setGuildConfig(guildId, config); // cache in redis for shards
    return config;
  } catch (err) {
    log.error({ err, guildId }, 'Failed to load automod config');
    return null;
  }
}

function safelyParseJSON(s) { try { return JSON.parse(s); } catch { return {}; } }

async function isExempt(message, rules) {
  const m = message.member;
  if (!m) return true;

  if (m.permissions.has(PermissionFlagsBits.Administrator) ||
      m.permissions.has(PermissionFlagsBits.ManageMessages)) return true;

  const exRoles = new Set();
  const exChans = new Set();
  for (const r of rules) {
    r.exempt_roles?.forEach(id => exRoles.add(id));
    r.exempt_channels?.forEach(id => exChans.add(id));
  }
  if (exChans.has(message.channelId)) return true;
  for (const id of m.roles.cache.keys()) if (exRoles.has(id)) return true;

  return false;
}

// ------------------------------
// Rule checkers
// ------------------------------
async function checkRule(message, rule, state) {
  switch (rule.type) {
    case 'spam':         return checkSpamRule(message, rule, state);
    case 'channel_spam': return checkChannelSpamRule(message, rule, state);
    case 'mention_spam': return checkMentionSpamRule(message, rule, state);
    case 'caps':         return checkCapsRule(message, rule);
    case 'invite':       return checkInviteRule(message);
    case 'link':         return checkLinkRule(message);
    case 'keyword':      return checkKeywordRule(message, rule);
    case 'regex':        return checkRegexRule(message, rule);
    default:             return null;
  }
}

async function checkSpamRule(message, rule, state) {
  const threshold = rule.threshold || 5;
  const windowMs = ((rule.rule_data?.window_seconds || rule.duration_seconds) || 5) * 1000;
  const count = await state.getMessageCount(message.author.id, message.guildId, windowMs);
  return (count >= threshold)
    ? { type: 'spam', details: { messageCount: count, threshold, timeWindow: windowMs / 1000 } }
    : null;
}

async function checkChannelSpamRule(message, rule, state) {
  const threshold = rule.threshold || 3;
  const windowMs = ((rule.rule_data?.window_seconds || rule.duration_seconds) || 10) * 1000;
  const unique = await state.getUniqueChannelCount(message.author.id, message.guildId, windowMs);
  return (unique >= threshold)
    ? { type: 'channel_spam', details: { channelCount: unique, threshold, timeWindow: windowMs / 1000 } }
    : null;
}

async function checkMentionSpamRule(message, rule, state) {
  const threshold = rule.threshold || 4;
  const windowMs = ((rule.rule_data?.window_seconds || rule.duration_seconds) || 5) * 1000;
  const current = message.mentions.users.size + message.mentions.roles.size;
  if (current >= threshold) {
    return { type: 'mention_spam', details: { mentionCount: current, threshold } };
  }
  if (current > 0) {
    const total = await state.getMentionCount(message.author.id, message.guildId, windowMs);
    if (total >= threshold) {
      return { type: 'mention_spam', details: { totalMentions: total, threshold, timeWindow: windowMs / 1000 } };
    }
  }
  return null;
}

function checkCapsRule(message, rule) {
  const text = message.content;
  if (!text || text.length < 10) return null;
  const letters = text.match(/[a-zA-Z]/g);
  if (!letters || letters.length < 10) return null;
  const caps = text.match(/[A-Z]/g) || [];
  const pct = Math.round((caps.length / letters.length) * 100);
  const threshold = rule.threshold || 70;
  return (pct >= threshold)
    ? { type: 'caps', details: { capsPercentage: pct, threshold } }
    : null;
}

function checkInviteRule(message) {
  const re = /discord(?:app)?\.(?:com\/invite|gg)\/[\w-]+/gi;
  const matches = message.content?.match(re);
  return matches ? { type: 'invite', details: { inviteCount: matches.length } } : null;
}

function checkLinkRule(message) {
  const re = /https?:\/\/(?!(?:discord|cdn\.discord)(?:app)?\.(?:com|gg|net))[^\s<>]+/gi;
  const matches = message.content?.match(re);
  return matches ? { type: 'link', details: { linkCount: matches.length } } : null;
}

function checkKeywordRule(message, rule) {
  const pattern = rule.pattern;
  if (!pattern) return null;
  const keys = pattern.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return null;
  const content = (message.content || '').toLowerCase();
  const found = keys.filter(k => content.includes(k));
  return found.length ? { type: 'keyword', details: { matched: found.length } } : null;
}

async function checkRegexRule(message, rule) {
  const pat = rule.pattern;
  if (!pat || pat.length > MAX_REGEX_LENGTH) return null;
  try {
    const rx = new RegExp(pat, 'giu');
    const matches = await Promise.race([
      Promise.resolve(message.content.match(rx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('regex_timeout')), REGEX_TIMEOUT_MS))
    ]);
    return matches ? { type: 'regex', details: { matchCount: matches.length } } : null;
  } catch { return null; }
}

function reasonFromViolation(v) {
  switch (v.type) {
    case 'spam': return 'Message spam';
    case 'channel_spam': return 'Cross-channel spam';
    case 'mention_spam': return 'Excessive mentions';
    case 'caps': return 'Excessive capital letters';
    case 'invite': return 'Unauthorized invite';
    case 'link': return 'Unauthorized external link';
    case 'keyword': return 'Prohibited content';
    case 'regex': return 'Pattern match';
    default: return 'Rule violation';
  }
}
