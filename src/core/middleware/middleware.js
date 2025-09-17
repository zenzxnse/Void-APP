// src/core/middleware.js
// Middleware for command validation: owner, perms, context, cooldowns.
// Integrates with client.stats for telemetry (denies, errors).

import { ChannelType, MessageFlags } from "discord.js";
import { claimNonce } from "../../infra/reply-guard.js";
import { applyCooldown } from "./cooldown.js";

// ---- Cooldowns: expiry map + lazy GC (no per-key timers) ----
const cooldowns = new Map(); // key -> expiryTs (ms)
let lastGc = 0; // Last GC timestamp (ms)

// ---- Owner resolution (ENV first, otherwise cached app owner/team) ----
const OWNER_IDS = new Set(
    (process.env.OWNER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

let _ownerCache = null; // Set<string> | null
let _ownerCacheTs = 0; // Cache timestamp (ms)
const OWNER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function isOwner(interaction) {
    if (OWNER_IDS.size) return OWNER_IDS.has(interaction.user.id);

    const now = Date.now();
    if (_ownerCache && now < _ownerCacheTs + OWNER_CACHE_TTL) {
        return _ownerCache.has(interaction.user.id);
    }

    // Fetch and cache
    try {
        await interaction.client.application?.fetch();
    } catch (err) {
        console.error("Failed to fetch application for owner check:", err);
        _ownerCache = new Set(); // Avoid refetch loop
        _ownerCacheTs = now;
        return false;
    }

    const owner = interaction.client.application?.owner;
    const ids = new Set();
    if (!owner) {
        _ownerCache = ids;
        _ownerCacheTs = now;
        return false;
    }

    if (owner.id) {
        ids.add(owner.id);
    } else if (owner.members) {
        for (const tm of owner.members.values()) ids.add(tm.id);
    }

    _ownerCache = ids;
    _ownerCacheTs = now;
    return ids.has(interaction.user.id);
}

function hasUserPerms(interaction, requiredPerms) {
    if (!interaction.inGuild()) return false;
    const mp = interaction.memberPermissions;
    return !!mp && requiredPerms.every((p) => mp.has(p, true));
}

function hasBotPerms(interaction, requiredPerms) {
    if (!interaction.inGuild()) return true; // Bot perms not checked in DMs
    if (!requiredPerms?.length) return true;
    const me = interaction.guild?.members?.me;
    if (!me) {
        console.warn(
            `Bot member unavailable for perms check in guild ${interaction.guildId}`
        );
        return false;
    }

    const perms = me.permissionsIn(interaction.channelId);
    return perms.has(requiredPerms, true);
}

function safeBumpDenies(client, reason) {
    const stats = (client.stats ??= {});
    const denies = (stats.denies ??= {});
    denies[reason] = (denies[reason] ?? 0) + 1;
}

function cooldownKey(name, interaction) {
    // Per-guild user scoping; DMs are separate namespace
    const scope = interaction.guildId ?? "dm";
    return `${scope}:${name}:${interaction.user.id}`;
}

function gcCooldowns(nowTs = Date.now()) {
    // GC every 5min or if map grows large
    const interval = 5 * 60 * 1000; // 5min
    if (nowTs < lastGc + interval && cooldowns.size < 1000) return;
    lastGc = nowTs;
    for (const [k, exp] of cooldowns) if (nowTs >= exp) cooldowns.delete(k);
}

/**
 * runMiddleware
 * @param {import('discord.js').Interaction} interaction
 * @param {{
 *   data: { name: string },
 *   cooldownMs?: number,
 *   requiredPerms?: import('discord.js').PermissionResolvable[],
 *   requiredBotPerms?: import('discord.js').PermissionResolvable[],
 *   guildOnly?: boolean,
 *   ownerOnly?: boolean,
 *   dmPermission?: boolean,     // default: true
 *   ownerBypass?: boolean       // default: true
 * }} command
 * @returns {Promise<{ok: true} | {ok:false, reason:string, remaining?:number}>}
 */
export async function runMiddleware(interaction, command) {
    const { client } = interaction;
    const {
        cooldownMs,
        requiredPerms = [],
        requiredBotPerms = [],
        guildOnly = false,
        ownerOnly = false,
        dmPermission = true,
        ownerBypass = true,
    } = command;

    const name = command?.data?.name ?? "unknown";
    const userIsOwner = await isOwner(interaction).catch(() => false);

    try {
        const first = await claimNonce(interaction.client, `cmd:${name}:${interaction.id}`, 900);
        if (!first) {
        await deny('⚠️ duplicate submit ignored.');
        return { ok: false, reason: 'duplicate' };
        }
    } catch { /* limp open if needed */ }

    // ...later, REPLACE your old cooldown block with:
    if (cooldownMs && cooldownMs > 0 && !(ownerBypass && userIsOwner)) {
        const res = await applyCooldown(interaction, name, cooldownMs);
        if (!res.ok) {
        const msg = res.remaining ? `On cooldown: ${res.remaining}s remaining.` : 'On cooldown.';
        await deny(msg);
        return { ok: false, reason: 'cooldown', remaining: res.remaining };
        }
    }

    // 1) Context checks
    if (
        !dmPermission &&
        !interaction.inGuild() &&
        !(ownerBypass && userIsOwner)
    ) {
        safeBumpDenies(client, "dmBlocked");
        await deny("This command can’t be used in DMs.");
        return { ok: false, reason: "dmBlocked" };
    }
    if (guildOnly && !interaction.inGuild() && !(ownerBypass && userIsOwner)) {
        safeBumpDenies(client, "guildOnly");
        await deny("This command is guild-only.");
        return { ok: false, reason: "guildOnly" };
    }

    // 2) Owner-only
    if (ownerOnly && !userIsOwner) {
        safeBumpDenies(client, "ownerOnly");
        await deny("Only the bot owner can use this command.");
        return { ok: false, reason: "ownerOnly" };
    }

    // 3) User perms (guild)
    if (!userIsOwner || !ownerBypass) {
        if (requiredPerms.length && !hasUserPerms(interaction, requiredPerms)) {
            safeBumpDenies(client, "userPerms");
            await deny("You lack the required permissions for this command.");
            return { ok: false, reason: "userPerms" };
        }
    }

    // 4) Bot perms (guild)
    if (requiredBotPerms.length && !hasBotPerms(interaction, requiredBotPerms)) {
        safeBumpDenies(client, "botPerms");
        await deny("I’m missing required permissions in this channel.");
        return { ok: false, reason: "botPerms" };
    }

    // 5) Cooldown (per guild/user/command; DMs are separate namespace)
    if (cooldownMs && cooldownMs > 0 && !(ownerBypass && userIsOwner)) {
        const now = Date.now();
        const key = cooldownKey(name, interaction);
        const exp = cooldowns.get(key) || 0;
        if (now < exp) {
            safeBumpDenies(client, "cooldown");
            const remaining = Math.ceil((exp - now) / 1000);
            await deny(`On cooldown: ${remaining}s remaining.`);
            return { ok: false, reason: "cooldown", remaining };
        }
        cooldowns.set(key, now + cooldownMs);
        gcCooldowns(now);
    }

    return { ok: true };

    async function deny(msg) {
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: msg, ephemeral: true });
            } else if (interaction.deferred) {
                try {
                    await interaction.editReply({ content: msg });
                } catch {
                    await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
                }
            } else {
                await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
            }
        } catch (err) {
            console.warn(`Failed to send deny message: ${msg}`, err);
        }
    }
}
