// Hardened helpers for moderation commands (discord.js v14)
import {
  MessageFlags,
  ChannelType,
  time,
  EmbedBuilder
} from 'discord.js';

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
 * reply helper for interactions.
 * Returns:
 *  - if payload.fetchReply === true => Promise<Message|null>
 *  - else => Promise<boolean>
 */
export async function safeReply(interaction, payload = {}) {
  // flags are authoritative; accept ephemeral for back-compat then normalize to flags
  const ephFromFlags = hasEphFlag(payload.flags);
  const ephFromBool  = payload.ephemeral === true;
  const wantEph      = ephFromFlags || ephFromBool;

  // Shallow clone arrays; don’t mutate caller
  let body = {
    ...payload,
    embeds: toArray(payload.embeds),
    components: toArray(payload.components),
    files: toArray(payload.files),
    allowedMentions: payload.allowedMentions ?? { parse: [], users: [], roles: [], repliedUser: false },
  };

  // Normalize color early
  if (!isValidColor(body.color)) delete body.color;

  // Honor explicit single embed
  if (body.embed && (!body.embeds || body.embeds.length === 0)) {
    body.embeds = [body.embed];
  }
  delete body.embed;

  // Auto-embed only if: content present, no embeds already, and not plain
  const shouldAutoEmbed =
    typeof body.content === 'string' &&
    body.content.length > 0 &&
    !body.plain &&
    (!body.embeds || body.embeds.length === 0);

  if (shouldAutoEmbed) {
    const LIMITS = REPLY_LIMITS; // assumes your constants module
    const color = isValidColor(body.color) ? body.color : (STATUS_COLORS[body.status] ?? STATUS_COLORS.default);
    const desc  = sliceEllipsis(body.content, LIMITS.EMBED_DESC * 10); // allow room before we split
    const title = body.title ? sliceEllipsis(body.title, LIMITS.EMBED_TITLE) : undefined;

    const footerText = interaction?.user?.tag ? `Requested by ${interaction.user.tag}` : undefined;

    // Build one or many embeds by splitting description into <=4096 chunks (max 10 embeds)
    const parts = splitByLimit(desc, LIMITS.EMBED_DESC);
    const embeds = parts.map((part, idx) => {
      const e = new EmbedBuilder().setColor(color).setTimestamp();
      if (idx === 0 && title) e.setTitle(title);
      if (part) e.setDescription(part);
      if (idx === 0 && footerText) {
        e.setFooter({ text: footerText, iconURL: interaction?.user?.displayAvatarURL?.() });
      }
      return e;
    });

    body = { ...body, embeds };
    delete body.content;
    delete body.title;
  }

  // Chunk long plain text (only when sending raw content)
  const needsChunking = body.plain && typeof body.content === 'string' && body.content.length > REPLY_LIMITS.PLAIN;
  const chunks = needsChunking ? chunk(body.content, REPLY_LIMITS.PLAIN) : null;

  // Never try to set flags/ephemeral on edit
  const {
    flags: _flagsIgnored,
    ephemeral: _ephIgnored,
    plain: _plainIgnored,
    status: _statusIgnored,
    color: _colorIgnored,
    title: _titleIgnored,
    fetchReply, // keep this
    ...clean
  } = body;

  // Build initial payload with flags (only for reply/followUp — not editReply)
  const withFlags = (p) =>
    wantEph
      ? { ...p, flags: (p.flags ?? 0) | MessageFlags.Ephemeral }
      : p;

  const send = async (method, firstPayload, restChunks) => {
    const initial = await method({ ...withFlags(firstPayload), fetchReply });
    if (needsChunking && restChunks?.length) {
      for (const part of restChunks) {
        await interaction.followUp({ ...withFlags({ content: part, allowedMentions: clean.allowedMentions }), fetchReply: false });
      }
    }
    return fetchReply ? (initial ?? null) : true;
  };

  try {
    if (!interaction.deferred && !interaction.replied) {
      if (needsChunking) {
        const [head, ...tail] = chunks;
        return await send(interaction.reply.bind(interaction), { ...clean, content: head }, tail);
      }
      return await send(interaction.reply.bind(interaction), clean);
    }

    if (interaction.deferred && !interaction.replied) {
      // editReply cannot change flags/ephemeral; fetchReply ignored by discord.js here
      if (needsChunking) {
        const [head, ...tail] = chunks;
        await interaction.editReply({ ...clean, content: head });
        for (const part of tail) {
          await interaction.followUp({ ...withFlags({ content: part, allowedMentions: clean.allowedMentions }) });
        }
        return fetchReply ? null : true;
      }
      await interaction.editReply(clean);
      return fetchReply ? null : true;
    }

    // already replied → followUp
    if (needsChunking) {
      for (const part of chunks) {
        await interaction.followUp({ ...withFlags({ content: part, allowedMentions: clean.allowedMentions }) });
      }
      return fetchReply ? null : true;
    }
    return await send(interaction.followUp.bind(interaction), clean);
  } catch (err) {
    // 40060: interaction already acknowledged → fallback to followUp
    const code = err?.code ?? err?.rawError?.code;
    if (code === 40060) {
      try {
        if (needsChunking) {
          for (const part of (chunks ?? [])) {
            await interaction.followUp({ ...withFlags({ content: part, allowedMentions: clean.allowedMentions }) });
          }
          return fetchReply ? null : true;
        }
        const msg = await interaction.followUp({ ...withFlags(clean), fetchReply });
        return fetchReply ? (msg ?? null) : true;
      } catch {
        return fetchReply ? null : false;
      }
    }
    return fetchReply ? null : false;
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
