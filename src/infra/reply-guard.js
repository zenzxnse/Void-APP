// src/infra/replay-guard.js
import { createLogger } from '../core/logger.js';
const log = createLogger({ mod: 'replay-guard' });

// Try Redis; fall back to in-memory map
const memory = new Map(); // key -> expiryTs

export async function claimNonce(client, key, ttlSec = 900) {
  // Prefer our wrapper if present
  if (client?.redis?.claimNonce) {
    try {
      return await client.redis.claimNonce(key, ttlSec); // uses SET NX EX under the hood
    } catch (err) {
      log.warn({ err }, 'Redis claimNonce failed; falling back to memory');
    }
  } else if (client?.redis?.set) {
    // If you’re ever running a raw ioredis instance
    try {
      const res = await client.redis.set(key, '1', 'EX', ttlSec, 'NX');
      return res === 'OK';
    } catch (err) {
      log.warn({ err }, 'Raw redis.set failed; falling back to memory');
    }
  }

  // In-process fallback (cross-shard unsafe but fine as limp mode)
  const now = Date.now();
  for (const [k, exp] of memory) if (exp <= now) memory.delete(k);
  if (memory.has(key) && memory.get(key) > now) return false;
  memory.set(key, now + ttlSec * 1000);
  return true;
}
