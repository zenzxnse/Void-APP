// src/infra/redis.js
import Redis from 'ioredis';
import { createLogger } from '../core/logger.js';
import env from '../core/env-config.js';

const log = createLogger({ mod: 'redis' });

let client = null;
let available = false;

// minimal in-memory fallback with TTL for limp mode
class TTLMap {
  constructor() { this.map = new Map(); }
  set(key, val, ttlSec) {
    this.map.set(key, val);
    if (ttlSec) setTimeout(() => this.map.delete(key), ttlSec * 1000).unref?.();
  }
  get(key) { return this.map.get(key); }
  has(key) { return this.map.has(key); }
  del(key) { this.map.delete(key); }
  ttl(/* key */) { return -1; } // not tracked here
}
const fallback = {
  kv: new TTLMap(),
  sets: new Map(),
  hashes: new Map(),
};

export function getRedisClient() { return client; }

export async function initRedis() {
  try {
    client = new Redis(env.REDIS_URL, {
      keyPrefix: env.REDIS_KEY_PREFIX,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });

    client.on('error', (err) => {
      if (available) log.error({ err }, 'Redis error');
      available = false;
    });
    client.on('end', () => { available = false; log.warn('Redis connection ended'); });
    client.on('reconnecting', () => { log.warn('Redis reconnecting'); });

    await client.connect();
    await client.ping();
    available = true;
    log.info('Redis connected');
  } catch (err) {
    if (!env.REDIS_LIMP_MODE) throw err;
    log.warn({ err }, 'Redis unavailable; entering limp mode (local fallback).');
    client = null;
    available = false;
  }
}

export function redisAvailable() { return available; }

export function attachRedisTo(clientLike) {
  clientLike.redis = {
    // cooldown: SET key 1 EX ttl NX → returns 'OK' if set, null if exists
    setNXEX: async (key, ttlSec) => {
      if (available) {
        // FIX: Pass EX and NX as separate arguments, not an object.
        return client.set(key, '1', 'EX', ttlSec, 'NX');
      }
      // fallback
      if (fallback.kv.has(key)) return null;
      fallback.kv.set(key, '1', ttlSec);
      return 'OK';
    },
    ttl: async (key) => {
      if (available) return client.ttl(key);
      return fallback.kv.ttl(key);
    },

    // anti-replay: SET key '1' EX ttl NX (atomic) or SADD set key + expire
    claimNonce: async (key, ttlSec) => {
        if (available) {
          // FIX: Pass EX and NX as separate arguments, not an object.
          return client.set(key, '1', 'EX', ttlSec, 'NX');
        }
      if (fallback.kv.has(key)) return null;
      fallback.kv.set(key, '1', ttlSec);
      return 'OK';
    },

    // hash helpers for guild config cache
    hgetall: async (key) => {
      if (available) return client.hgetall(key);
      return Object.fromEntries(fallback.hashes.get(key) ?? []);
    },
    hset: async (key, obj, ttlSec) => {
      if (available) {
        const flat = Object.entries(obj).flat();
        if (flat.length) await client.hset(key, flat);
        if (ttlSec) await client.expire(key, ttlSec);
        return;
      }
      const m = new Map(Object.entries(obj));
      fallback.hashes.set(key, m);
      if (ttlSec) setTimeout(() => fallback.hashes.delete(key), ttlSec * 1000).unref?.();
    },
    del: async (key) => {
      if (available) return client.del(key);
      fallback.kv.del(key); fallback.hashes.delete(key);
    },

    ping: async () => (available ? client.ping() : 'LIMP'),
  };

  return clientLike.redis;
}
