// src/utils/automod/redis-state.js
import { createLogger } from '../../core/logger.js';
import { EventEmitter } from 'node:events';

const log = createLogger({ mod: 'automod:redis' });

export class AutoModState extends EventEmitter {
    constructor(redisClient) {
        super();
        this.redis = redisClient;
        this.sub = null;
        this.keyPrefix = 'automod:';
        this.defaultTTL = 300; // 5 minutes for configs
        this.trackingTTL = 300; // 5 minutes for tracking data
    }

    // Guild configuration caching
    async getGuildConfig(guildId) {
        const key = `${this.keyPrefix}config:${guildId}`;

        try {
            const cached = await this.redis.hgetall(key);
            if (cached && Object.keys(cached).length > 0) {
                return {
                    enabled: cached.enabled === 'true',
                    rules: JSON.parse(cached.rules || '[]'),
                    expires: parseInt(cached.expires || '0')
                };
            }
        } catch (err) {
            log.debug({ err, guildId }, 'Failed to get cached config');
        }

        return null;
    }

    async setGuildConfig(guildId, config) {
        const key = `${this.keyPrefix}config:${guildId}`;
        const expires = Date.now() + (this.defaultTTL * 1000);

        try {
            await this.redis.multi()
                .hset(key, {
                    enabled: config.enabled.toString(),
                    rules: JSON.stringify(config.rules),
                    expires: expires.toString()
                })
                .expire(key, this.defaultTTL)
                .exec();

            // Broadcast cache invalidation to other shards
            await this.redis.publish(`${this.keyPrefix}invalidate`, JSON.stringify({
                type: 'guild_config',
                guildId
            }));
        } catch (err) {
            log.error({ err, guildId }, 'Failed to cache guild config');
        }
    }

    async invalidateGuildConfig(guildId) {
        const key = `${this.keyPrefix}config:${guildId}`;

        try {
            await this.redis.del(key);
            await this.redis.publish(`${this.keyPrefix}invalidate`, JSON.stringify({
                type: 'guild_config',
                guildId
            }));
        } catch (err) {
            log.error({ err, guildId }, 'Failed to invalidate guild config');
        }
    }

    // Message spam tracking
    async trackMessage(userId, guildId, timestamp = Date.now()) {
        const key = `${this.keyPrefix}spam:${guildId}:${userId}`;

        try {
            // Add timestamp to sorted set and remove old entries
            const multi = this.redis.multi();
            multi.zadd(key, timestamp, timestamp);
            multi.zremrangebyscore(key, 0, timestamp - (this.trackingTTL * 1000));
            multi.expire(key, this.trackingTTL);
            await multi.exec();
        } catch (err) {
            log.debug({ err, userId, guildId }, 'Failed to track message');
        }
    }

    async getMessageCount(userId, guildId, windowMs) {
        const key = `${this.keyPrefix}spam:${guildId}:${userId}`;
        const cutoff = Date.now() - windowMs;

        try {
            return await this.redis.zcount(key, cutoff, '+inf');
        } catch (err) {
            log.debug({ err, userId, guildId }, 'Failed to get message count');
            return 0;
        }
    }
    async close() {
        try {
            if (!this.sub) return;
            const channel = `${this.keyPrefix}invalidate`;

            // node-redis v4: unsubscribe(channel)
            if (typeof this.sub.unsubscribe === 'function' && this.sub.unsubscribe.length <= 1) {
                try { await this.sub.unsubscribe(channel); } catch { }
            }

            // ioredis: unsubscribe() without args unsubscribes all
            if (typeof this.sub.unsubscribe === 'function' && this.sub.unsubscribe.length === 0) {
                try { await this.sub.unsubscribe(); } catch { }
            }

            try { this.sub.removeAllListeners?.('message'); } catch { }
            try { await this.sub.quit?.(); } catch { }
        } finally {
            this.sub = null;
        }
    }

    // Mention spam tracking
    async trackMentions(userId, guildId, mentionCount, timestamp = Date.now()) {
        const key = `${this.keyPrefix}mentions:${guildId}:${userId}`;

        try {
            const multi = this.redis.multi();
            multi.zadd(key, timestamp, `${timestamp}:${mentionCount}`);
            multi.zremrangebyscore(key, 0, timestamp - (this.trackingTTL * 1000));
            multi.expire(key, this.trackingTTL);
            await multi.exec();
        } catch (err) {
            log.debug({ err, userId, guildId }, 'Failed to track mentions');
        }
    }

    async getMentionCount(userId, guildId, windowMs) {
        const key = `${this.keyPrefix}mentions:${guildId}:${userId}`;
        const cutoff = Date.now() - windowMs;

        try {
            const entries = await this.redis.zrangebyscore(key, cutoff, '+inf');
            return entries.reduce((total, entry) => {
                const [, count] = entry.split(':');
                return total + parseInt(count || '0', 10);
            }, 0);
        } catch (err) {
            log.debug({ err, userId, guildId }, 'Failed to get mention count');
            return 0;
        }
    }

    // Channel spam tracking
    async trackChannelUsage(userId, guildId, channelId, timestamp = Date.now()) {
        const key = `${this.keyPrefix}channels:${guildId}:${userId}`;

        try {
            const multi = this.redis.multi();
            multi.zadd(key, timestamp, `${timestamp}:${channelId}`);
            multi.zremrangebyscore(key, 0, timestamp - (this.trackingTTL * 1000));
            multi.expire(key, this.trackingTTL);
            await multi.exec();
        } catch (err) {
            log.debug({ err, userId, guildId }, 'Failed to track channel usage');
        }
    }

    async getUniqueChannelCount(userId, guildId, windowMs) {
        const key = `${this.keyPrefix}channels:${guildId}:${userId}`;
        const cutoff = Date.now() - windowMs;

        try {
            const entries = await this.redis.zrangebyscore(key, cutoff, '+inf');
            const channels = new Set();
            entries.forEach(entry => {
                const [, channelId] = entry.split(':', 2);
                if (channelId) channels.add(channelId);
            });
            return channels.size;
        } catch (err) {
            log.debug({ err, userId, guildId }, 'Failed to get channel count');
            return 0;
        }
    }

    // Action deduplication (prevent double-actions)
    async acquireActionLock(guildId, userId, action, ttlSeconds = 10) {
        const key = `${this.keyPrefix}lock:${guildId}:${userId}:${action}`;

        try {
            const result = await this.redis.set(key, Date.now(), 'EX', ttlSeconds, 'NX');
            return result === 'OK';
        } catch (err) {
            log.debug({ err, guildId, userId, action }, 'Failed to acquire action lock');
            return false;
        }
    }

    async releaseActionLock(guildId, userId, action) {
        const key = `${this.keyPrefix}lock:${guildId}:${userId}:${action}`;

        try {
            await this.redis.del(key);
        } catch (err) {
            log.debug({ err, guildId, userId, action }, 'Failed to release action lock');
        }
    }

    // Rule error tracking (auto-quarantine bad rules)
    async trackRuleError(guildId, ruleId, error) {
        const key = `${this.keyPrefix}errors:${guildId}:${ruleId}`;
        const timestamp = Date.now();

        try {
            const multi = this.redis.multi();
            multi.zadd(key, timestamp, `${timestamp}:${error.substring(0, 100)}`);
            multi.zremrangebyscore(key, 0, timestamp - (15 * 60 * 1000)); // Keep 15min of errors
            multi.expire(key, 900); // 15 minutes
            const errorCount = await multi.exec();

            // Count errors in last 5 minutes
            const recentErrors = await this.redis.zcount(key, timestamp - (5 * 60 * 1000), '+inf');
            return recentErrors;
        } catch (err) {
            log.error({ err, guildId, ruleId }, 'Failed to track rule error');
            return 0;
        }
    }

    // Bulk cleanup operations
    async cleanupExpiredData() {
        const patterns = [
            `${this.keyPrefix}spam:*`,
            `${this.keyPrefix}mentions:*`,
            `${this.keyPrefix}channels:*`,
            `${this.keyPrefix}errors:*`
        ];

        let cleaned = 0;
        for (const pattern of patterns) {
            try {
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    const pipeline = this.redis.pipeline();
                    for (const key of keys) {
                        // Remove entries older than TTL
                        pipeline.zremrangebyscore(key, 0, Date.now() - (this.trackingTTL * 1000));
                    }
                    const results = await pipeline.exec();
                    cleaned += results.filter(([err, result]) => !err && result > 0).length;
                }
            } catch (err) {
                log.error({ err, pattern }, 'Cleanup failed for pattern');
            }
        }

        if (cleaned > 0) {
            log.info({ cleaned }, 'Cleaned up expired auto-mod data');
        }

        return cleaned;
    }

    // Cache invalidation subscription
    async subscribeToInvalidations(callback) {
        try {
            if (!this.sub) {
                // Prefer the official duplicator if present (works on both ioredis & node-redis v4)
                if (typeof this.redis.duplicate === 'function') {
                    this.sub = this.redis.duplicate();
                } else {
                    // Fallback to constructing a new client from the same options (ioredis classic)
                    this.sub = new this.redis.constructor(this.redis.options || {});
                }

                // Some clients auto-connect, some need an explicit connect()
                if (typeof this.sub.connect === 'function') {
                    await this.sub.connect();
                }
            }

            const channel = `${this.keyPrefix}invalidate`;

            // node-redis v4: subscribe(channel, listener)
            if (this.sub.subscribe && this.sub.subscribe.length >= 2) {
                await this.sub.subscribe(channel, (message) => {
                    try {
                        const data = JSON.parse(message);
                        callback?.(data);
                    } catch (err) {
                        log.error({ err, message }, 'Failed to parse invalidation message');
                    }
                });
                return;
            }

            // ioredis: subscribe(channel) + 'message' event
            await this.sub.subscribe(channel);
            this.sub.on?.('message', (ch, message) => {
                if (ch !== channel) return;
                try {
                    const data = JSON.parse(message);
                    callback?.(data);
                } catch (err) {
                    log.error({ err, message }, 'Failed to parse invalidation message');
                }
            });
        } catch (err) {
            log.error({ err }, 'Failed to subscribe to cache invalidations');
        }
    }

    // Metrics collection
    async getMetrics() {
        try {
            const pipeline = this.redis.pipeline();

            // Count active tracking keys
            pipeline.eval(`
        local spam = #redis.call('KEYS', ARGV[1])
        local mentions = #redis.call('KEYS', ARGV[2])
        local channels = #redis.call('KEYS', ARGV[3])
        local configs = #redis.call('KEYS', ARGV[4])
        return {spam, mentions, channels, configs}
      `, 0,
                `${this.keyPrefix}spam:*`,
                `${this.keyPrefix}mentions:*`,
                `${this.keyPrefix}channels:*`,
                `${this.keyPrefix}config:*`
            );

            const [counts] = await pipeline.exec();
            const [spam, mentions, channels, configs] = counts[1];

            return {
                activeSpamTracking: spam,
                activeMentionTracking: mentions,
                activeChannelTracking: channels,
                cachedConfigs: configs,
                timestamp: Date.now()
            };
        } catch (err) {
            log.error({ err }, 'Failed to get metrics');
            return null;
        }
    }
}

// Singleton instance for the bot
let autoModState = null;

export function createAutoModState(redisClient) {
    if (!autoModState) {
        autoModState = new AutoModState(redisClient);

        // Set up cleanup interval
        setInterval(() => {
            autoModState.cleanupExpiredData().catch(err => {
                log.error({ err }, 'Scheduled cleanup failed');
            });
        }, 5 * 60 * 1000); // Every 5 minutes
    }

    return autoModState;
}

export function getAutoModState() {
    if (!autoModState) {
        throw new Error('AutoModState not initialized. Call createAutoModState() first.');
    }
    return autoModState;
}