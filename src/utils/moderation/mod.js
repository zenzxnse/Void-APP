// Hardened helpers for moderation commands (discord.js v14)
import {
  MessageFlags,
  ChannelType,
  time,
  EmbedBuilder
} from 'discord.js';

import { colors } from '../../graphics/colors.js';

const MAX_REASON = 512;

/** Clamp + sanitize a reason for audit logs */
export function normalizeReason(input) {
  const reason = String(input ?? '').trim().replace(/\s+/g, ' ');
  return reason.length > MAX_REASON ? reason.slice(0, MAX_REASON - 1) + '…' : reason;
}

export function ensureInGuild(interaction) {
  if (!interaction.inGuild()) throw new Error('GuildOnly');
}

/** Role hierarchy: can actor act on target, and can bot act on target? */
export function checkHierarchy({ guild, me, actor, target }) {
  if (!guild) return { ok: false, why: 'NoGuild' };
  if (!target) return { ok: false, why: 'NoTarget' };
  if (target.id === guild.ownerId) return { ok: false, why: 'TargetIsOwner' };
  if (target.id === actor.id) return { ok: false, why: 'SelfTarget' };
  if (target.id === me.id) return { ok: false, why: 'TargetIsBot' };

  const aPos = guild.members.me?.roles?.highest?.position ?? 0;
  const bPos = target.roles?.highest?.position ?? 0;
  const uPos = actor.roles?.highest?.position ?? 0;

  if (aPos <= bPos) return { ok: false, why: 'BotBelowTarget' };
  if (uPos <= bPos) return { ok: false, why: 'ActorBelowTarget' };

  return { ok: true };
}

export const REPLY_LIMITS = Object.freeze({
  PLAIN: 2000,
  EMBED_DESC: 4096,
  EMBED_TITLE: 256,
  EMBED_SOFT_TOTAL: 6000, // conservative overall guard
});

export const hasEphFlag = (f) => typeof f === 'number' && (f & MessageFlags.Ephemeral) !== 0;

const STATUS_COLORS = Object.freeze({
  success: 0x2ecc71,
  error:   0xff4d4f,
  warn:    0xffa940,
  info:    0x4098ff,
  neutral: 0x9aa0a6,
  default: 0x2ecc71,
});

const sliceEllipsis = (str, max) =>
  (typeof str === 'string' && str.length > max) ? (str.slice(0, Math.max(0, max - 1)) + '…') : str;

const toArray = (v) => (Array.isArray(v) ? v.slice() : v == null ? undefined : [v]);

// imports assumed in your file:
// import { EmbedBuilder, MessageFlags } from 'discord.js';
// import { toArray, chunk, sliceEllipsis, hasEphFlag, STATUS_COLORS, REPLY_LIMITS } from './wherever.js';

function isValidColor(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 0xFFFFFF;
}

function splitByLimit(text, limit) {
  if (!text) return [];
  const out = [];
  let i = 0;
  while (i < text.length && out.length < 10) { // Discord max 10 embeds
    out.push(text.slice(i, i + limit));
    i += limit;
  }
  return out;
}

/**
 * Safe reply helper for interactions.
 *
 * - Respects ephemeral via flags or payload.ephemeral === true
 * - Auto-wraps content into embeds unless payload.plain === true
 * - Chunks long plain messages
 * - Handles reply / editReply / followUp correctly
 * - Gracefully falls back on interaction 40060 errors
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {Object} payload
 * @returns {Promise<boolean>} true on best-effort success, false on hard failure
 */
export async function safeReply(interaction, payload = {}) {
  // ----- ephemeral resolution (flags only go to Discord) -----
  const ephFromFlags = hasEphFlag(payload.flags);
  const ephFromBool = payload.ephemeral === true;
  const wantEph = ephFromFlags || ephFromBool;

  // ----- normalize arrays & allowedMentions -----
  let body = {
    ...payload,
    embeds: toArray(payload.embeds),
    components: toArray(payload.components),
    files: toArray(payload.files),
    allowedMentions:
      payload.allowedMentions ?? {
        parse: [],
        users: [],
        roles: [],
        repliedUser: false,
      },
  };

  // Reject raw color if invalid
  if (!isValidColor(body.color)) delete body.color;

  // Honor explicit single embed
  if (body.embed && (!body.embeds || body.embeds.length === 0)) {
    body.embeds = [body.embed];
  }
  delete body.embed;

  // ----- color resolution helpers -----
  const pickEmbedColor = () => {
    // 1) default palette color
    let chosen = Number.isFinite(colors?.default) ? colors.default : undefined;

    // 2) status → palette (takes precedence over explicit color)
    const statusKey =
      typeof body.status === "string" ? body.status.trim() : null;
    if (statusKey && Number.isFinite(colors?.[statusKey])) {
      chosen = colors[statusKey];
    }
    // 3) explicit numeric color (fallback)
    else if (isValidColor(body.color)) {
      chosen = body.color;
    }

    return isValidColor(chosen) ? chosen : undefined;
  };

  // ----- auto-embed for non-plain content -----
  const shouldAutoEmbed =
    typeof body.content === "string" &&
    body.content.length > 0 &&
    !body.plain &&
    (!body.embeds || body.embeds.length === 0);

  if (shouldAutoEmbed) {
    const LIMITS = REPLY_LIMITS;
    const color = pickEmbedColor();
    const desc = sliceEllipsis(body.content, LIMITS.EMBED_DESC * 10);
    const title = body.title
      ? sliceEllipsis(body.title, LIMITS.EMBED_TITLE)
      : undefined;

    const footerText = interaction?.user?.tag
      ? `Requested by ${interaction.user.tag}`
      : undefined;

    const parts = splitByLimit(desc, LIMITS.EMBED_DESC);

    const embeds = parts.map((part, idx) => {
      const e = new EmbedBuilder().setTimestamp();
      if (isValidColor(color)) e.setColor(color);
      if (idx === 0 && title) e.setTitle(title);
      if (part) e.setDescription(part);
      if (idx === 0 && footerText) {
        e.setFooter({
          text: footerText,
          iconURL: interaction?.user?.displayAvatarURL?.(),
        });
      }
      return e;
    });

    body = { ...body, embeds };
    delete body.content;
    delete body.title;
  }

  // ----- plain content chunking -----
  const needsChunking =
    body.plain &&
    typeof body.content === "string" &&
    body.content.length > REPLY_LIMITS.PLAIN;
  const chunks = needsChunking ? chunk(body.content, REPLY_LIMITS.PLAIN) : null;

  // Strip fields that should not go to Discord
  const {
    flags: _flagsIgnored,
    ephemeral: _ephIgnored,
    plain: _plainIgnored,
    status: _statusIgnored,
    color: _colorIgnored,
    title: _titleIgnored,
    ...clean
  } = body;

  const withFlags = (p) =>
    wantEph
      ? { ...p, flags: (p.flags ?? 0) | MessageFlags.Ephemeral }
      : p;

  const send = async (method, firstPayload, restChunks) => {
    // Initial send (reply or followUp)
    await method(withFlags(firstPayload));

    // Extra chunks (plain only)
    if (needsChunking && restChunks?.length) {
      for (const part of restChunks) {
        await interaction.followUp(
          withFlags({
            content: part,
            allowedMentions: clean.allowedMentions,
          }),
        );
      }
    }
    return true;
  };

  try {
    // Not yet acknowledged
    if (!interaction.deferred && !interaction.replied) {
      if (needsChunking) {
        const [head, ...tail] = chunks;
        return await send(
          interaction.reply.bind(interaction),
          { ...clean, content: head },
          tail,
        );
      }
      return await send(interaction.reply.bind(interaction), clean);
    }

    // Deferred, not replied yet → editReply as main response
    if (interaction.deferred && !interaction.replied) {
      if (needsChunking) {
        const [head, ...tail] = chunks;
        await interaction.editReply({ ...clean, content: head });
        for (const part of tail) {
          await interaction.followUp(
            withFlags({
              content: part,
              allowedMentions: clean.allowedMentions,
            }),
          );
        }
        return true;
      }
      await interaction.editReply(clean);
      return true;
    }

    // Already replied → followUps only
    if (needsChunking) {
      for (const part of chunks) {
        await interaction.followUp(
          withFlags({
            content: part,
            allowedMentions: clean.allowedMentions,
          }),
        );
      }
      return true;
    }

    return await send(interaction.followUp.bind(interaction), clean);
  } catch (err) {
    const code = err?.code ?? err?.rawError?.code;

    // 40060: "Interaction has already been acknowledged" → fallback to followUp
    if (code === 40060) {
      try {
        if (needsChunking) {
          for (const part of chunks ?? []) {
            await interaction.followUp(
              withFlags({
                content: part,
                allowedMentions: clean.allowedMentions,
              }),
            );
          }
          return true;
        }

        await interaction.followUp(withFlags(clean));
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}



function chunk(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

function chunkString(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

/** Pretty “until” helper */
export function untilTs(msFromNow) {
  const ts = new Date(Date.now() + msFromNow);
  return `${time(ts, 'R')} (${time(ts, 'T')})`;
}

/** Ensure the bot has a specific permission in this channel */
export function requireBotPermsInChannel(interaction, perms) {
  const me = interaction.guild?.members?.me;
  if (!me) return false;
  const resolved = me.permissionsIn(interaction.channelId);
  return resolved.has(perms, true);
}

/** Minimal mod-log emitter; wire to your logging channel/system later */
export async function emitModLog(interaction, payload) {
  // TODO: integrate with your logging strategy (db/webhook/channel)
  interaction.client?.logger?.info?.(payload) || console.log('[MODLOG]', payload);
}

/** For purge: channel guard (no DMs, no voice, no forum root) */
export function canPurgeChannel(channel) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel?.type);
}

/** Standard error mapping */
export function humanizeError(code) {
  switch (code) {
    case 'GuildOnly': return 'This command can only be used in a server.';
    case 'NoTarget': return 'Target not found.';
    case 'TargetIsOwner': return 'You can’t act on the server owner.';
    case 'SelfTarget': return 'You can’t target yourself.';
    case 'TargetIsBot': return 'You can’t target the bot.';
    case 'BotBelowTarget': return 'I can’t act on that member due to role hierarchy.';
    case 'ActorBelowTarget': return 'You can’t act on that member due to role hierarchy.';
    default: return 'Action failed.';
  }
}

export async function tryDM(interaction, embed, ephemeral) {
  const wantDM = interaction.options.getBoolean('dm') ?? false;
  if (!wantDM) {
    return safeReply(interaction, { embeds: [embed], ...(ephemeral && { flags: MessageFlags.Ephemeral }) });
  }
  try {
    const dm = await interaction.user.createDM();
    await dm.send({ embeds: [embed] });
    return safeReply(interaction, { content: '📬 Sent to your DMs.', flags: MessageFlags.Ephemeral });
  } catch {
    return safeReply(interaction, { content: '⚠️ Couldn’t DM you. Showing here instead:', flags: MessageFlags.Ephemeral })
      .then(() => safeReply(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral }));
  }
};

export function getColorForType(type) {
  const colors = {
    note: 0x808080,
    warn: 0xFFA500,
    timeout: 0xFF6347,
    mute: 0xFF4500,
    kick: 0xFF0000,
    ban: 0x8B0000,
    softban: 0xDC143C,
    unmute: 0x00FF00,
    untimeout: 0x00FF00,
    unban: 0x00FF00,
    pardon: 0x00FF00,
  };
  return colors[type] || 0x000000;
}
