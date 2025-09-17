import { createLogger } from '../logger.js';
const log = createLogger({ mod: 'mw:cooldown' });

const mem = new Map(); // key -> expiryTs
let lastGc = 0;

function gc(now = Date.now()) {
  if (now < lastGc + 5 * 60 * 1000 && mem.size < 2000) return;
  lastGc = now;
  for (const [k, exp] of mem) if (now >= exp) mem.delete(k);
}

async function setOnce(client, key, ttlSec) {
  if (client.redis) {
    try {
      const ok = await client.redis.set(`cd:${key}`, '1', 'EX', ttlSec, 'NX');
      return ok === 'OK';
    } catch (err) {
      log.warn({ err }, 'Redis cooldown SET failed; using memory');
    }
  }
  const now = Date.now();
  const exp = mem.get(key) || 0;
  if (exp > now) return false;
  mem.set(key, now + ttlSec * 1000);
  gc(now);
  return true;
}

async function ttl(client, key) {
  if (client.redis) {
    try {
      const t = await client.redis.ttl(`cd:${key}`);
      return t;
    } catch {}
  }
  const exp = mem.get(key) || 0;
  const rem = Math.ceil((exp - Date.now()) / 1000);
  return rem > 0 ? rem : -2;
}

/** applyCooldown(interaction, name, ms) → {ok:true}|{ok:false,remaining} */
export async function applyCooldown(interaction, name, ms) {
  if (!ms || ms <= 0) return { ok: true };
  const scope = interaction.guildId ?? 'dm';
  const userId = interaction.user.id;
  const ttlSec = Math.ceil(ms / 1000);
  const key = `${scope}:${name}:${userId}`;
  const ok = await setOnce(interaction.client, key, ttlSec);
  if (ok) return { ok: true };
  const remaining = await ttl(interaction.client, key);
  return { ok: false, remaining: remaining > 0 ? remaining : undefined };
}
