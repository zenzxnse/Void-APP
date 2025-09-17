// src/infra/shard-routing.js
// Minimal, predictable routing helpers for shard-partitioned work.

import { createHash } from 'node:crypto';

export class ShardRouter {
  /**
   * @param {number} shardId
   * @param {number} shardCount
   */
  constructor(shardId, shardCount) {
    if (!Number.isInteger(shardId) || shardId < 0) throw new Error('Invalid shardId');
    if (!Number.isInteger(shardCount) || shardCount <= 0) throw new Error('Invalid shardCount');
    this.shardId = shardId;
    this.shardCount = shardCount;
  }

  /**
   * Discord’s routing formula (match the gateway): (guildId >> 22) % shardCount
   * @param {string|bigint|number} guildId
   */
  shardForGuild(guildId) {
    const id = typeof guildId === 'bigint' ? guildId : BigInt(String(guildId));
    return Number((id >> 22n) % BigInt(this.shardCount));
  }

  /**
   * Is THIS shard responsible for the given guild?
   * @param {string|bigint|number} guildId
   */
  isResponsibleForGuild(guildId) {
    return this.shardForGuild(guildId) === this.shardId;
  }

  /**
   * Deterministic hash → shard for arbitrary keys (non-guild jobs).
   * @param {string} key
   */
  shardForKey(key) {
    const h = createHash('sha1').update(String(key)).digest(); // 20 bytes
    // read first 4 bytes as unsigned int
    const n = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
    // convert to unsigned 32-bit
    const u = n >>> 0;
    return u % this.shardCount;
  }

  /**
   * Is THIS shard responsible for an arbitrary-keyed job?
   * @param {string} key
   */
  isResponsibleForKey(key) {
    return this.shardForKey(key) === this.shardId;
  }

  /**
   * Split a guild’s work into N buckets deterministically (e.g., per-feature throttling).
   * @param {string|bigint|number} guildId
   * @param {number} buckets
   */
  bucketForGuild(guildId, buckets) {
    if (!Number.isInteger(buckets) || buckets <= 0) throw new Error('buckets must be > 0');
    const id = typeof guildId === 'bigint' ? guildId : BigInt(String(guildId));
    return Number((id >> 22n) % BigInt(buckets));
  }

  /**
   * Split an arbitrary key into N buckets (on this shard).
   * Useful if you run parallel workers per shard.
   * @param {string} key
   * @param {number} buckets
   */
  bucketForKey(key, buckets) {
    if (!Number.isInteger(buckets) || buckets <= 0) throw new Error('buckets must be > 0');
    const h = createHash('sha1').update(String(key)).digest();
    const u = (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0);
    return u % buckets;
  }
}

export default ShardRouter;
