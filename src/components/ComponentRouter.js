/**
 * @file ComponentRouter.js
 * @module components/ComponentRouter
 * @description Production-ready Discord.js component interaction router with security,
 * persistence, and middleware integration. Handles buttons, select menus, and modals
 * with cryptographic signature verification, anti-replay protection, and automatic
 * guild config caching.
 * 
 * @requires discord.js
 * @requires crypto (Node.js built-in)
 * @requires ../core/logger
 * @requires ../core/middleware/middleware
 * @requires ../core/db/index
 * @requires ../utils/helpers/persistence
 * 
 * @author Your Name
 * @version 1.0.0
 * @license MIT
 * 
 * @example
 * import createComponentRouter from './ComponentRouter.js';
 * 
 * const router = createComponentRouter(client);
 * 
 * router.button('game:join', {
 *   async execute(interaction, context) {
 *     await interaction.reply('Joined!');
 *   }
 * });
 */

// File: src/components/ComponentRouter.js

import { PermissionFlagsBits } from 'discord.js';
import { createLogger, forInteraction } from '../core/logger.js';
import { runMiddleware } from '../core/middleware/middleware.js';
import { query, tx } from '../core/db/index.js';
import { createHmac, randomBytes } from 'node:crypto';
import { componentKey } from '../utils/helpers/persistence.js';

const log = createLogger({ mod: 'ComponentRouter' });

// ============================================================================
// CONFIGURATION
// ============================================================================

// Require secret from environment
if (!process.env.COMPONENT_SECRET) {
  log.fatal('COMPONENT_SECRET not set. Components will break on restart!');
  throw new Error('COMPONENT_SECRET environment variable is required');
}

/**
 * @constant {Object} CONFIG
 * @description Global configuration object for component router
 * @property {string} ID_SECRET - HMAC secret from environment variable
 * @property {number} DEFAULT_TTL - Default time-to-live for custom IDs (seconds)
 * @property {number} MAX_ID_LENGTH - Maximum allowed custom ID length (Discord limit)
 * @property {number} GUILD_CACHE_TTL - Guild config cache duration (milliseconds)
 * @property {number} CLOCK_SKEW_TOLERANCE - Tolerance for time differences (seconds)
 * @property {number} MAX_USED_IDS - Maximum anti-replay entries before GC
 * @property {number} USED_ID_TTL - Anti-replay entry lifetime (milliseconds)
 */
const CONFIG = {
  ID_SECRET: process.env.COMPONENT_SECRET,
  DEFAULT_TTL: 900, // 15 minutes
  MAX_ID_LENGTH: 100,
  GUILD_CACHE_TTL: 60000, // 1 minute
  CLOCK_SKEW_TOLERANCE: 30, // 30 seconds
  MAX_USED_IDS: 10000,
  USED_ID_TTL: 3600000, // 1 hour
};

// ============================================================================
// ANTI-REPLAY MECHANISM
// *brief: In-memory store to prevent replay of used IDs
// ============================================================================

/**
 * @class AntiReplayGuard
 * @description In-memory store to prevent duplicate component submissions.
 * Uses a time-based Map with automatic garbage collection to track used component IDs.
 * 
 * @property {Map<string, number>} used - Map of component keys to expiry timestamps
 * @property {number} lastGC - Last garbage collection timestamp
 * 
 * @example
 * const guard = new AntiReplayGuard();
 * if (guard.check('unique-key-123')) {
 *   // First time - allow action
 * } else {
 *   // Duplicate - deny action
 * }
 */
class AntiReplayGuard {
  /**
   * Creates a new anti-replay guard instance
   * @constructor
   */
  constructor() {
    this.used = new Map(); // key -> expiryTs
    this.lastGC = Date.now();
  }

  /**
   * Check if a key has been used and mark it as used
   * @param {string} key - Unique identifier to check
   * @param {number} [ttlMs=CONFIG.USED_ID_TTL] - Time-to-live in milliseconds
   * @returns {boolean} True if first use (allowed), false if already used (denied)
   * 
   * @example
   * if (guard.check('button:abc123:user456', 3600000)) {
   *   console.log('First click - processing');
   * } else {
   *   console.log('Duplicate click - ignored');
   * }
   */
  check(key, ttlMs = CONFIG.USED_ID_TTL) {
    const now = Date.now();
    
    // Garbage collection
    if (now - this.lastGC > 60000 || this.used.size > CONFIG.MAX_USED_IDS) {
      this.gc(now);
    }
    
    // Check if already used
    const expiry = this.used.get(key);
    if (expiry && expiry > now) {
      return false; // Already used
    }
    
    // Mark as used
    this.used.set(key, now + ttlMs);
    return true;
  }

  /**
   * Garbage collection - removes expired entries
   * @param {number} [now=Date.now()] - Current timestamp for testing
   * @returns {void}
   * @private
   * 
   * @description Runs automatically when map grows large or every minute.
   * Stops early if map size drops below half of MAX_USED_IDS.
   */
  gc(now = Date.now()) {
    this.lastGC = now;
    let deleted = 0;
    
    for (const [key, expiry] of this.used) {
      if (expiry <= now) {
        this.used.delete(key);
        deleted++;
      }
      
      // Stop if we've cleaned enough
      if (this.used.size < CONFIG.MAX_USED_IDS / 2) break;
    }
    
    if (deleted > 0) {
      log.debug({ deleted, remaining: this.used.size }, 'Anti-replay GC');
    }
  }
}

const antiReplay = new AntiReplayGuard();

// ============================================================================
// SECURE CUSTOM ID SYSTEM
// ============================================================================

/**
 * @class SecureCustomId
 * @description Cryptographically signed custom ID builder with context validation.
 * Creates tamper-proof custom IDs that encode user, guild, channel, expiry,
 * and custom data. IDs are signed with HMAC-SHA256 for integrity verification.
 * 
 * @property {string} namespace - Component namespace (e.g., 'game', 'ticket')
 * @property {string} action - Action identifier (e.g., 'join', 'close')
 * @property {string} version - Version string (e.g., 'v1', 'v2')
 * @property {Object} data - Encoded data object
 * 
 * @example
 * const id = new SecureCustomId('game', 'move', 'v1')
 *   .setContext(interaction)
 *   .setData({ position: 4, gameId: 'abc123' })
 *   .setTTL(3600)
 *   .build();
 * // Returns: 'game:move:v1:eyJ1Ijoi...':Ab12Cd34Ef56
 */
export class SecureCustomId {
  /**
   * Create a new secure custom ID builder
   * @constructor
   * @param {string} namespace - Component namespace (required)
   * @param {string} action - Action identifier (required)
   * @param {string} [version='v1'] - Version string for future compatibility
   * 
   * @example
   * new SecureCustomId('ticket', 'close', 'v1')
   * new SecureCustomId('poll', 'vote') // version defaults to 'v1'
   */
  constructor(namespace, action, version = 'v1') {
    this.namespace = namespace;
    this.action = action;
    this.version = version;
    this.data = {};
  }

  /**
   * Set interaction context (user, guild, channel, message)
   * @param {Interaction} interaction - Discord.js interaction object
   * @returns {SecureCustomId} This instance for chaining
   * 
   * @description Automatically captures:
   * - User ID (u)
   * - Guild ID or 'd' for DMs (g)
   * - Channel ID (c)
   * - Message ID if available (m)
   * - Expiry timestamp (e)
   * - Random nonce for uniqueness (n)
   * 
   * @example
   * customId.setContext(interaction)
   */
  setContext(interaction) {
    this.data.u = interaction.user.id;
    this.data.g = interaction.guildId || 'd';
    this.data.c = interaction.channelId;
    this.data.m = interaction.message?.id || null;
    this.data.e = Math.floor(Date.now() / 1000) + CONFIG.DEFAULT_TTL;
    this.data.n = randomBytes(6).toString('hex');
    return this;
  }

  /**
   * Set custom data payload
   * @param {Object} custom - Custom data to embed (will be JSON stringified)
   * @returns {SecureCustomId} This instance for chaining
   * 
   * @description Keep payload small! Discord has 100-char limit for custom IDs.
   * Store IDs and references, not large objects.
   * 
   * @example
   * customId.setData({ gameId: 'abc123', position: 4 })
   * customId.setData({ ticketId: '12345' })
   */
  setData(custom) {
    this.data.d = custom;
    return this;
  }

  /**
   * Set time-to-live (overrides default)
   * @param {number} seconds - TTL in seconds
   * @returns {SecureCustomId} This instance for chaining
   * 
   * @example
   * customId.setTTL(3600)   // 1 hour
   * customId.setTTL(86400)  // 24 hours
   * customId.setTTL(300)    // 5 minutes
   */
  setTTL(seconds) {
    this.data.e = Math.floor(Date.now() / 1000) + seconds;
    return this;
  }

  /**
   * Build and sign the custom ID
   * @returns {string} Signed custom ID string
   * @throws {Error} If final ID exceeds MAX_ID_LENGTH (100 chars)
   * 
   * @description Format: namespace:action:version:base64url(payload):signature
   * Signature is HMAC-SHA256 of unsigned string, truncated to 12 chars.
   * 
   * @example
   * const id = customId.build();
   * // 'game:move:v1:eyJkIjp7InAiOjR9fQ:Ab12Cd34Ef56'
   */
  build() {
    const payload = Buffer.from(JSON.stringify(this.data)).toString('base64url');
    const prefix = `${this.namespace}:${this.action}:${this.version}`;
    const unsigned = `${prefix}:${payload}`;
    
    const signature = createHmac('sha256', CONFIG.ID_SECRET)
      .update(unsigned)
      .digest('base64url')
      .substring(0, 12);
    
    const final = `${unsigned}:${signature}`;
    
    if (final.length > CONFIG.MAX_ID_LENGTH) {
      throw new Error(`Custom ID too long: ${final.length} chars`);
    }
    
    return final;
  }

  /**
   * Parse and verify a custom ID
   * @static
   * @param {string} customId - Custom ID to parse
   * @param {Interaction} [interaction=null] - Interaction for context validation
   * @returns {ParsedCustomId|null} Parsed object or null if invalid
   * 
   * @description Performs:
   * - Signature verification (HMAC-SHA256)
   * - Expiry validation (with clock skew tolerance)
   * - Context validation (user, guild, channel match)
   * - Admin bypass for user mismatch
   * 
   * @example
   * const parsed = SecureCustomId.parse(interaction.customId, interaction);
   * if (parsed) {
   *   console.log(parsed.data.custom.gameId);
   * }
   */
  static parse(customId, interaction = null) {
    try {
      const parts = customId.split(':');
      if (parts.length < 5) return null;
      
      const [namespace, action, version, payload, signature] = parts;
      const unsigned = parts.slice(0, 4).join(':');
      
      // Verify signature
      const expectedSig = createHmac('sha256', CONFIG.ID_SECRET)
        .update(unsigned)
        .digest('base64url')
        .substring(0, 12);
      
      if (signature !== expectedSig) {
        log.debug('Invalid signature');
        return null;
      }
      
      // Decode payload
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      
      // Check expiry with clock skew tolerance
      const now = Math.floor(Date.now() / 1000);
      if (data.e) {
        if (now > data.e + CONFIG.CLOCK_SKEW_TOLERANCE) {
          log.debug('Custom ID expired');
          return null;
        }
      }
      
      // Verify context if interaction provided
      if (interaction) {
        // User must match (unless admin)
        if (data.u && data.u !== interaction.user.id) {
          const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
          if (!isAdmin) {
            log.debug('User mismatch in custom ID');
            return null;
          }
        }
        
        // Guild must match
        const currentGuild = interaction.guildId || 'd';
        if (data.g && data.g !== currentGuild) {
          log.debug('Guild mismatch in custom ID');
          return null;
        }
        
        // Channel should match (warning only)
        if (data.c && data.c !== interaction.channelId) {
          log.debug('Channel mismatch in custom ID (allowed)');
        }
      }
      
      return {
        namespace,
        action,
        version,
        prefix: `${namespace}:${action}`,
        versionedPrefix: `${namespace}:${action}:${version}`,
        data: {
          userId: data.u,
          guildId: data.g === 'd' ? null : data.g,
          channelId: data.c,
          messageId: data.m,
          expires: data.e,
          nonce: data.n,
          custom: data.d || {}
        },
        raw: customId
      };
    } catch (err) {
      log.debug({ err }, 'Failed to parse custom ID');
      return null;
    }
  }
}


/**
 * Helper function to quickly create signed custom IDs
 * @function makeId
 * @param {string} namespace - Component namespace
 * @param {string} action - Action identifier
 * @param {Interaction} interaction - Discord interaction
 * @param {Object} [custom={}] - Custom data payload
 * @param {number} [ttl=CONFIG.DEFAULT_TTL] - TTL in seconds
 * @returns {string} Signed custom ID
 * 
 * @example
 * // Simple ID with defaults
 * makeId('game', 'join', interaction)
 * 
 * // With custom data
 * makeId('poll', 'vote', interaction, { option: 'yes' })
 * 
 * // With custom TTL (1 hour)
 * makeId('ticket', 'close', interaction, { ticketId: '123' }, 3600)
 */
export function makeId(ns, action, interaction, custom = {}, ttl = CONFIG.DEFAULT_TTL) {
  return new SecureCustomId(ns, action)
    .setContext(interaction)
    .setData(custom)
    .setTTL(ttl)
    .build();
}

/**
 * @typedef {Object} ParsedCustomId
 * @property {string} namespace - Component namespace
 * @property {string} action - Action identifier
 * @property {string} version - Version string
 * @property {string} prefix - 'namespace:action' (unversioned)
 * @property {string} versionedPrefix - 'namespace:action:version'
 * @property {ParsedData} data - Decoded data object
 * @property {string} raw - Original custom ID string
 */

/**
 * @typedef {Object} ParsedData
 * @property {string} userId - User who created the component
 * @property {string|null} guildId - Guild ID or null for DMs
 * @property {string} channelId - Channel ID
 * @property {string|null} messageId - Message ID if available
 * @property {number} expires - Unix timestamp (seconds)
 * @property {string} nonce - Random nonce for uniqueness
 * @property {Object} custom - Custom data payload
 */

// ============================================================================
// GUILD CONFIG CACHE WITH INVALIDATION
// ============================================================================

/**
 * @class GuildConfigCache
 * @description Automatic guild configuration caching with promise deduplication.
 * Prevents thundering herd by coalescing concurrent requests.
 * 
 * @property {Map<string, CacheEntry>} cache - Cached guild configs
 * @property {Map<string, Promise>} promises - In-flight fetch promises
 * 
 * @typedef {Object} CacheEntry
 * @property {Object} data - Guild config data
 * @property {number} expires - Expiry timestamp
 */
class GuildConfigCache {
  constructor() {
    this.cache = new Map();
    this.promises = new Map();
  }

  /**
   * Get guild config (from cache or database)
   * @async
   * @param {string} guildId - Guild ID
   * @returns {Promise<Object>} Guild config object
   * 
   * @description Automatically:
   * - Returns cached data if fresh
   * - Deduplicates concurrent requests
   * - Creates missing guild_config rows
   * - Caches result for GUILD_CACHE_TTL
   * 
   * @example
   * const config = await cache.get('123456789');
   * console.log(config.mute_role_id);
   */
  async get(guildId) {
    const cached = this.cache.get(guildId);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    if (this.promises.has(guildId)) {
      return this.promises.get(guildId);
    }

    const promise = this.fetch(guildId);
    this.promises.set(guildId, promise);
    
    try {
      return await promise;
    } finally {
      this.promises.delete(guildId);
    }
  }

  /**
   * Fetch guild config from database
   * @async
   * @private
   * @param {string} guildId - Guild ID
   * @returns {Promise<Object>} Guild config
   */
  async fetch(guildId) {
    try {
      const { rows: [config] } = await query(
        'SELECT * FROM guild_config WHERE guild_id = $1',
        [guildId]
      );
      
      if (!config) {
        await query(
          'INSERT INTO guild_config (guild_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [guildId]
        );
        const newConfig = { guild_id: guildId };
        this.set(guildId, newConfig);
        return newConfig;
      }
      
      this.set(guildId, config);
      return config;
    } catch (err) {
      log.error({ err, guildId }, 'Failed to fetch guild config');
      return null;
    }
  }

  /**
   * Manually set cache entry
   * @param {string} guildId - Guild ID
   * @param {Object} data - Config data
   * @returns {void}
   */
  set(guildId, data) {
    this.cache.set(guildId, {
      data,
      expires: Date.now() + CONFIG.GUILD_CACHE_TTL
    });
  }

  /**
   * Invalidate cached entry
   * @param {string} guildId - Guild ID
   * @returns {void}
   * 
   * @example
   * cache.invalidate('123456789');
   */
  invalidate(guildId) {
    this.cache.delete(guildId);
    this.promises.delete(guildId);
    log.debug({ guildId }, 'Guild config cache invalidated');
  }

  /**
   * Clear all cached entries
   * @returns {void}
   */
  clear() {
    this.cache.clear();
    this.promises.clear();
  }
}

// ============================================================================
// COMPONENT REGISTRY
// ============================================================================

/**
 * @class ComponentRegistry
 * @description Registry for component handlers with pattern matching support.
 * Handles versioned and unversioned handler lookup.
 * 
 * @property {string} type - Component type (button, select, modal)
 * @property {Map<string, Handler>} handlers - Registered handlers by key
 * @property {Array<PatternEntry>} patterns - Regex pattern handlers
 * 
 * @typedef {Object} PatternEntry
 * @property {RegExp} pattern - Regex pattern
 * @property {Handler} handler - Handler function
 */
class ComponentRegistry {
  constructor(type) {
    this.type = type;
    this.handlers = new Map();
    this.patterns = [];
  }

  /**
   * Register a handler by key
   * @param {string} key - Handler key (namespace:action)
   * @param {Handler|Function} handler - Handler object or function
   * @returns {ComponentRegistry} This instance for chaining
   * 
   * @example
   * registry.register('game:move', {
   *   async execute(interaction, context) { }
   * });
   */
  register(key, handler) {
    this.handlers.set(key, this.normalizeHandler(handler));
    return this;
  }

  /**
   * Register a pattern-based handler
   * @param {RegExp} pattern - Regex pattern to match
   * @param {Handler|Function} handler - Handler object or function
   * @returns {ComponentRegistry} This instance for chaining
   * 
   * @example
   * registry.registerPattern(/^legacy_\w+$/, handler);
   */
  registerPattern(pattern, handler) {
    this.patterns.push({
      pattern,
      handler: this.normalizeHandler(handler)
    });
    return this;
  }

  /**
   * Find handler for parsed custom ID
   * @param {ParsedCustomId} parsed - Parsed custom ID
   * @returns {Handler|null} Handler or null if not found
   * 
   * @description Lookup order:
   * 1. Versioned key (namespace:action:version)
   * 2. Unversioned key (namespace:action)
   * 3. Pattern match on raw custom ID
   */
  findHandler(parsed) {
    if (!parsed) return null;
    
    // Try versioned key first
    if (this.handlers.has(parsed.versionedPrefix)) {
      return this.handlers.get(parsed.versionedPrefix);
    }
    
    // Try unversioned
    if (this.handlers.has(parsed.prefix)) {
      return this.handlers.get(parsed.prefix);
    }
    
    // Try patterns on parsed.raw (after signature verification)
    for (const { pattern, handler } of this.patterns) {
      if (pattern.test(parsed.raw)) {
        return handler;
      }
    }
    
    return null;
  }

  /**
   * Normalize handler to standard format
   * @private
   * @param {Handler|Function} handler - Raw handler
   * @returns {NormalizedHandler} Normalized handler
   * 
   * @description Converts function to object and sets defaults:
   * - defer: 'auto'
   * - replayScope: 'id'
   * - ephemeral: true
   * - callerOnly: false
   * - persistent: false
   */
  normalizeHandler(handler) {
    if (typeof handler === 'function') {
      handler = { execute: handler };
    }
    
    return {
      execute: handler.execute,
      data: { name: handler.name || this.type },
      
      // Middleware compatibility
      cooldownMs: handler.cooldownMs,
      requiredPerms: handler.requiredPerms,
      requiredBotPerms: handler.requiredBotPerms,
      guildOnly: handler.guildOnly ?? false,
      dmPermission: handler.dmPermission ?? true,
      ownerOnly: handler.ownerOnly ?? false,
      ownerBypass: handler.ownerBypass ?? true,
      
      // Component-specific
      defer: handler.defer ?? 'auto',
      replayScope: handler.replayScope ?? 'id', // 'id' | 'user' | 'channel' | 'none'
      ephemeral: handler.ephemeral ?? true,
      callerOnly: handler.callerOnly ?? false,
      allowedUsers: handler.allowedUsers ? new Set(handler.allowedUsers) : null,
      allowedRoles: handler.allowedRoles ? new Set(handler.allowedRoles) : null,
      skipGuildConfig: handler.skipGuildConfig ?? false,
      persistent: handler.persistent ?? false,
    };
  }
}


/**
 * @typedef {Object} Handler
 * @property {Function} execute - Execution function (required)
 * @property {string} [name] - Handler name for logging
 * 
 * @property {number} [cooldownMs] - Cooldown duration in milliseconds
 * @property {PermissionResolvable[]} [requiredPerms] - Required user permissions
 * @property {PermissionResolvable[]} [requiredBotPerms] - Required bot permissions
 * @property {boolean} [guildOnly=false] - Restrict to guilds only
 * @property {boolean} [dmPermission=true] - Allow in DMs
 * @property {boolean} [ownerOnly=false] - Bot owner only
 * @property {boolean} [ownerBypass=true] - Owner bypasses restrictions
 * 
 * @property {'auto'|'update'|'reply'|'none'|false} [defer='auto'] - Defer strategy
 * @property {'id'|'user'|'channel'|'none'} [replayScope='id'] - Anti-replay scope
 * @property {boolean} [ephemeral=true] - Reply ephemeral by default
 * @property {boolean} [callerOnly=false] - Only original user can interact
 * @property {string[]} [allowedUsers] - Whitelist of user IDs
 * @property {string[]} [allowedRoles] - Whitelist of role IDs
 * @property {boolean} [skipGuildConfig=false] - Skip guild config loading
 * @property {boolean} [persistent=false] - Enable database persistence
 */

// ============================================================================
// COMPONENT MIDDLEWARE
// ============================================================================

/**
 * @class ComponentMiddleware
 * @description Static middleware utilities for components
 */
class ComponentMiddleware {
  /**
   * Automatically defer interaction based on strategy
   * @static
   * @async
   * @param {Interaction} interaction - Discord interaction
   * @param {Handler} handler - Handler config
   * @returns {Promise<boolean>} True if successful
   * 
   * @description Strategies:
   * - 'auto': deferUpdate for components, deferReply for modals
   * - 'update': deferUpdate (no "thinking" state)
   * - 'reply': deferReply with ephemeral flag
   * - 'none'/false: No deferral
   */
  static async defer(interaction, handler) {
    if (interaction.deferred || interaction.replied) return true;
    
    const strategy = handler.defer;
    
    try {
      if (strategy === 'none' || strategy === false) {
        return true;
      }
      
      if (strategy === 'update') {
        if (interaction.isMessageComponent()) {
          await interaction.deferUpdate();
        }
        return true;
      }
      
      if (strategy === 'reply') {
        await interaction.deferReply({ ephemeral: handler.ephemeral });
        return true;
      }
      
      // Auto strategy
      if (interaction.isMessageComponent()) {
        await interaction.deferUpdate();
      } else if (interaction.isModalSubmit()) {
        await interaction.deferReply({ ephemeral: handler.ephemeral });
      }
      
      return true;
    } catch (err) {
      log.debug({ err }, 'Defer failed');
      
      // Try to send a fallback message
      try {
        await interaction.reply({
          content: 'Processing your request...',
          ephemeral: true
        });
      } catch {}
      
      return false;
    }
  }

  /**
   * Check if interaction user matches caller
   * @static
   * @param {Interaction} interaction - Discord interaction
   * @param {Handler} handler - Handler config
   * @param {ParsedCustomId} parsed - Parsed custom ID
   * @returns {boolean} True if allowed
   * 
   * @description Always true if callerOnly is false.
   * Otherwise checks interaction.user.id === parsed.data.userId
   */
  static checkCallerOnly(interaction, handler, parsed) {
    if (!handler.callerOnly) return true;
    
    if (parsed?.data?.userId) {
      return interaction.user.id === parsed.data.userId;
    }
    
    const originalUser = interaction.message?.interaction?.user;
    return !originalUser || interaction.user.id === originalUser.id;
  }

  /**
   * Check allowed users/roles
   * @static
   * @param {Interaction} interaction - Discord interaction
   * @param {Handler} handler - Handler config
   * @returns {boolean} True if allowed
   * 
   * @description Checks:
   * - allowedUsers whitelist (if defined)
   * - allowedRoles whitelist (if defined)
   * - Always true if no restrictions defined
   */
  static checkAllowed(interaction, handler) {
    if (handler.allowedUsers?.size > 0) {
      if (!handler.allowedUsers.has(interaction.user.id)) {
        return false;
      }
    }
    
    if (handler.allowedRoles?.size > 0 && interaction.inGuild()) {
      const hasRole = [...handler.allowedRoles].some(roleId => 
        interaction.member.roles.cache.has(roleId)
      );
      if (!hasRole) {
        return false;
      }
    }
    
    return true;
  }
}

// ============================================================================
// MAIN ROUTER
// ============================================================================

/**
 * @class ComponentRouter
 * @description Main router class - handles all component interactions
 * 
 * @property {Client} client - Discord.js client
 * @property {Map<string, ComponentRegistry>} registries - Type-specific registries
 * @property {GuildConfigCache} guildConfigCache - Guild config cache
 * 
 * @example
 * const router = new ComponentRouter(client);
 * 
 * router.button('game:join', {
 *   async execute(interaction, context) {
 *     await interaction.reply('Joined game!');
 *   }
 * });
 */
export class ComponentRouter {
  /**
   * Create a new component router
   * @constructor
   * @param {Client} client - Discord.js client instance
   * 
   * @description Automatically:
   * - Initializes all component registries
   * - Sets up guild config caching
   * - Installs event listeners
   * - Initializes telemetry
   */
  constructor(client) {
    this.client = client;
    this.registries = new Map();
    this.guildConfigCache = new GuildConfigCache();
    
    // Initialize registries
    const types = [
      'button',
      'string_select',
      'user_select', 
      'role_select',
      'mentionable_select',
      'channel_select',
      'modal'
    ];
    
    for (const type of types) {
      this.registries.set(type, new ComponentRegistry(type));
    }
    
    // Initialize stats
    if (!client.stats) client.stats = {};
    if (!client.stats.componentExecs) client.stats.componentExecs = new Map();
    if (!client.stats.componentDenials) client.stats.componentDenials = new Map();
    
    this.install();
  }

  // ========== Registration Methods ==========

  /**
   * Register a button handler
   * @param {string} key - Handler key (namespace:action)
   * @param {Handler|Function} handler - Handler object or function
   * @returns {ComponentRouter} This instance for chaining
   * 
   * @example
   * router.button('game:join', {
   *   callerOnly: false,
   *   defer: 'update',
   *   async execute(interaction, context) {
   *     const gameId = context.parsed.data.custom.gameId;
   *     await handleJoin(gameId, interaction.user);
   *     await interaction.update({ content: 'Joined!' });
   *   }
   * });
   */
  button(key, handler) {
    this.registries.get('button').register(key, handler);
    return this;
  }

  /**
   * Register a string select menu handler
   * @param {string} key - Handler key
   * @param {Handler|Function} handler - Handler
   * @returns {ComponentRouter} This instance
   * 
   * @example
   * router.stringSelect('config:setting', {
   *   async execute(interaction, context) {
   *     const selected = interaction.values[0];
   *     await updateSetting(selected);
   *   }
   * });
   */
  stringSelect(key, handler) {
    this.registries.get('string_select').register(key, handler);
    return this;
  }

  /**
   * Register a user select menu handler
   * @param {string} key - Handler key
   * @param {Handler|Function} handler - Handler
   * @returns {ComponentRouter} This instance
   * 
   * @example
   * router.userSelect('mod:target', {
   *   requiredPerms: [PermissionFlagsBits.ModerateMembers],
   *   async execute(interaction, context) {
   *     const user = interaction.users.first();
   *     await performModAction(user);
   *   }
   * });
   */
  userSelect(key, handler) {
    this.registries.get('user_select').register(key, handler);
    return this;
  }

  /**
   * Register a role select menu handler
   * @param {string} key - Handler key
   * @param {Handler|Function} handler - Handler
   * @returns {ComponentRouter} This instance
   */
  roleSelect(key, handler) {
    this.registries.get('role_select').register(key, handler);
    return this;
  }

  /**
   * Register a mentionable select menu handler
   * @param {string} key - Handler key
   * @param {Handler|Function} handler - Handler
   * @returns {ComponentRouter} This instance
   */
  mentionableSelect(key, handler) {
    this.registries.get('mentionable_select').register(key, handler);
    return this;
  }

  /**
   * Register a channel select menu handler
   * @param {string} key - Handler key
   * @param {Handler|Function} handler - Handler
   * @returns {ComponentRouter} This instance
   */
  channelSelect(key, handler) {
    this.registries.get('channel_select').register(key, handler);
    return this;
  }

  /**
   * Register a modal submit handler
   * @param {string} key - Handler key
   * @param {Handler|Function} handler - Handler
   * @returns {ComponentRouter} This instance
   * 
   * @example
   * router.modal('feedback:submit', {
   *   async execute(interaction, context) {
   *     const title = interaction.fields.getTextInputValue('title');
   *     const desc = interaction.fields.getTextInputValue('description');
   *     await saveFeedback(title, desc);
   *     await interaction.reply('Submitted!');
   *   }
   * });
   */
  modal(key, handler) {
    this.registries.get('modal').register(key, handler);
    return this;
  }

  // ========== Core Methods ==========

  /**
   * Install event listeners
   * @private
   * @returns {void}
   * 
   * @description Sets up:
   * - interactionCreate listener for components
   * - guildUpdate listener for cache invalidation
   */
  install() {
    // Component listener
    this.client.on('interactionCreate', (interaction) => {
      if (!this.isComponent(interaction)) return;
      
      const type = this.getComponentType(interaction);
      if (type) {
        this.handle(interaction, type).catch(err => {
          log.error({ err }, 'Unhandled router error');
        });
      }
    });
    
    // Guild update listener for cache invalidation
    this.client.on('guildUpdate', (oldGuild, newGuild) => {
      this.guildConfigCache.invalidate(newGuild.id);
    });
    
    log.info('Component router installed');
  }

  /**
   * Check if interaction is a component
   * @private
   * @param {Interaction} interaction - Discord interaction
   * @returns {boolean} True if component type
   */
  isComponent(interaction) {
    return interaction.isButton() ||
           interaction.isAnySelectMenu() ||
           interaction.isModalSubmit();
  }

  /**
   * Get component type from interaction
   * @private
   * @param {Interaction} interaction - Discord interaction
   * @returns {string|null} Component type or null
   */
  getComponentType(interaction) {
    if (interaction.isButton()) return 'button';
    if (interaction.isStringSelectMenu()) return 'string_select';
    if (interaction.isUserSelectMenu()) return 'user_select';
    if (interaction.isRoleSelectMenu()) return 'role_select';
    if (interaction.isMentionableSelectMenu()) return 'mentionable_select';
    if (interaction.isChannelSelectMenu()) return 'channel_select';
    if (interaction.isModalSubmit()) return 'modal';
    return null;
  }

  /**
   * Handle component interaction
   * @async
   * @param {Interaction} interaction - Discord interaction
   * @param {string} type - Component type
   * @returns {Promise<void>}
   * 
   * @description Main handler pipeline:
   * 1. Parse and verify custom ID
   * 2. Find handler
   * 3. Defer interaction
   * 4. Check anti-replay
   * 5. Run middleware (perms, cooldowns)
   * 6. Run component checks (caller, allowed)
   * 7. Load guild config
   * 8. Execute handler
   * 9. Store persistence
   * 10. Update telemetry
   */
  async handle(interaction, type) {
    const ilog = forInteraction(interaction);
    const startTime = Date.now();
    
    let handler = null;
    let parsed = null;
    
    try {
      // Parse and verify custom ID
      parsed = SecureCustomId.parse(interaction.customId, interaction);
      
      if (!parsed) {
        this.incrementDenial('invalidComponent');
        await this.replyError(interaction, 'This action has expired or is invalid.');
        return;
      }
      
      // Find handler
      const registry = this.registries.get(type);
      handler = registry.findHandler(parsed);
      
      if (!handler) {
        this.incrementDenial('unknownComponent');
        await this.replyError(interaction, 'This component is no longer active.');
        return;
      }
      
      // Defer immediately unless explicitly disabled
      if (handler.defer !== 'none' && handler.defer !== false) {
        await ComponentMiddleware.defer(interaction, handler);
      }

      // Anti-replay with scope (before middleware/handler)
      const scope = handler.replayScope ?? "id";
      if (scope !== "none") {
        const base = `${parsed.versionedPrefix}:${parsed.data.guildId ?? ""}:${
          parsed.data.messageId ?? ""
        }:${parsed.data.nonce}`;
        const replayKey =
          scope === "user"
            ? `${base}:u:${interaction.user.id}`
            : scope === "channel"
            ? `${base}:ch:${interaction.channelId}`
            : base; // 'id'
        if (!antiReplay.check(replayKey)) {
          this.incrementDenial("replay");
          await this.replyError(interaction, "This action was already used.");
          return;
        }
      }
      
      // Run standard middleware
      const middlewareResult = await runMiddleware(interaction, handler);
      
      if (!middlewareResult.ok) {
        this.incrementDenial(middlewareResult.reason);
        ilog.debug({ reason: middlewareResult.reason }, 'Denied by middleware');
        return;
      }
      
      // Component-specific checks
      if (!ComponentMiddleware.checkCallerOnly(interaction, handler, parsed)) {
        this.incrementDenial('callerOnly');
        await this.replyError(interaction, 'Only the original user can use this.');
        return;
      }
      
      if (!ComponentMiddleware.checkAllowed(interaction, handler)) {
        this.incrementDenial('notAllowed');
        await this.replyError(interaction, 'You are not authorized to use this.');
        return;
      }
      
      // Build context
      const context = {
        parsed,
        client: this.client,
        log: ilog,
        router: this
      };
      
      // Load guild config if needed
      if (!handler.skipGuildConfig && interaction.inGuild()) {
        context.guildConfig = await this.guildConfigCache.get(interaction.guildId);
      }
      
      // Execute handler
      try {
        await handler.execute(interaction, context);
        
        // Update stats
        const key = `${type}:${parsed.prefix}`;
        this.client.stats.componentExecs.set(key, 
          (this.client.stats.componentExecs.get(key) || 0) + 1
        );
        
        // Log success
        const duration = Date.now() - startTime;
        ilog.info({
          type,
          namespace: parsed.namespace,
          action: parsed.action,
          version: parsed.version,
          duration,
          userId: interaction.user.id,
          guildId: interaction.guildId
        }, 'Component handled');
        
        // Store persistent component if needed
        if (handler.persistent && interaction.message) {
          await this.storePersistentComponent(interaction, parsed, handler);
        }
        
      } catch (handlerError) {
        ilog.error({ 
          err: handlerError, 
          parsed,
          handler: handler.data.name 
        }, 'Handler execution failed');
        
        this.client.stats.errors = (this.client.stats.errors || 0) + 1;
        
        await this.replyError(interaction, 'An error occurred processing this action.');
      }
      
    } catch (routerError) {
      ilog.error({ 
        err: routerError,
        customId: interaction.customId,
        type 
      }, 'Component router error');
      
      this.client.stats.errors = (this.client.stats.errors || 0) + 1;
      
      await this.replyError(interaction, 'An unexpected error occurred.');
    }
  }

  /**
   * Store persistent component in database
   * @async
   * @private
   * @param {Interaction} interaction - Discord interaction
   * @param {ParsedCustomId} parsed - Parsed custom ID
   * @param {Handler} handler - Handler config
   * @returns {Promise<void>}
   * 
   * @description Inserts/updates persistent_components table with:
   * - Message ID
   * - Component type (unversioned)
   * - Component key (for deduplication)
   * - Component data (version, custom, handler name)
   * - Expiry timestamp
   */
async storePersistentComponent(interaction, parsed, handler) {
  try {
    const key = componentKey(parsed);
    await query(
      `INSERT INTO persistent_components (
         message_id, channel_id, guild_id,
         component_type, component_key, component_data,
         expires_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (message_id, component_key)
       DO UPDATE SET component_data = EXCLUDED.component_data,
                     expires_at   = EXCLUDED.expires_at`,
      [
        interaction.message.id,
        interaction.channelId,
        interaction.guildId || null,
        `${parsed.namespace}:${parsed.action}`,
        key,
        JSON.stringify({ version: parsed.version, custom: parsed.data.custom, handler: handler.data.name }),
        new Date((parsed.data.expires || 0) * 1000)
      ]
    );
  } catch (err) {
    log.error({ err }, 'Failed to store persistent component');
  }
}

  /**
   * Reply with error message
   * @async
   * @private
   * @param {Interaction} interaction - Discord interaction
   * @param {string} message - Error message
   * @returns {Promise<void>}
   */
  async replyError(interaction, message) {
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: message, ephemeral: true });
      } else {
        await interaction.followUp({ content: message, ephemeral: true });
      }
    } catch (err) {
      log.debug({ err }, 'Failed to send error reply');
    }
  }

  /**
   * Increment denial counter
   * @private
   * @param {string} reason - Denial reason
   * @returns {void}
   */
  incrementDenial(reason) {
    const count = this.client.stats.componentDenials.get(reason) || 0;
    this.client.stats.componentDenials.set(reason, count + 1);
    
    // Also increment legacy counter for compatibility
    if (this.client.stats.denies) {
      this.client.stats.denies[reason] = (this.client.stats.denies[reason] || 0) + 1;
    }
  }

  /**
   * Invalidate guild config cache
   * @param {string} guildId - Guild ID
   * @returns {void}
   * 
   * @example
   * // After updating guild config
   * await query('UPDATE guild_config SET ... WHERE guild_id = $1', [guildId]);
   * client.components.invalidateGuildCache(guildId);
   */
  invalidateGuildCache(guildId) {
    this.guildConfigCache.invalidate(guildId);
  }

  /**
   * Get detailed statistics
   * @returns {RouterStats} Statistics object
   * 
   * @typedef {Object} RouterStats
   * @property {Object} handlers - Handler counts by type
   * @property {Object} executions - Execution counts by key
   * @property {Object} denials - Denial counts by reason
   * @property {number} errors - Total error count
   * 
   * @example
   * const stats = router.getDetailedStats();
   * console.log(stats.handlers.button); // 15
   * console.log(stats.executions['button:game:join']); // 423
   */
  getDetailedStats() {
    const stats = {
      handlers: {},
      executions: {},
      denials: {},
      errors: this.client.stats.errors || 0
    };
    
    // Handler counts
    for (const [type, registry] of this.registries) {
      stats.handlers[type] = registry.handlers.size + registry.patterns.length;
    }
    
    // Execution counts
    for (const [key, count] of this.client.stats.componentExecs) {
      stats.executions[key] = count;
    }
    
    // Denial reasons
    for (const [reason, count] of this.client.stats.componentDenials) {
      stats.denials[reason] = count;
    }
    
    return stats;
  }
}

/**
 * @typedef {Object} Context
 * @description Context object passed to handler execute functions
 * 
 * @property {ParsedCustomId} parsed - Parsed custom ID data
 * @property {Client} client - Discord.js client
 * @property {Logger} log - Logger instance (bound to interaction)
 * @property {ComponentRouter} router - Router instance
 * @property {Object} [guildConfig] - Guild config (if !skipGuildConfig)
 * 
 * @example
 * async execute(interaction, context) {
 *   const { parsed, client, log, router, guildConfig } = context;
 *   
 *   const gameId = parsed.data.custom.gameId;
 *   const muteRole = guildConfig.mute_role_id;
 *   
 *   log.info({ gameId }, 'Processing game action');
 * }
 */


// ============================================================================
// FACTORY
// ============================================================================

/**
 * Factory function to create router
 * @function createComponentRouter
 * @param {Client} client - Discord.js client
 * @returns {ComponentRouter} Router instance
 * 
 * @example
 * import createComponentRouter from './ComponentRouter.js';
 * 
 * const router = createComponentRouter(client);
 * client.components = router;
 */
export default function createComponentRouter(client) {
  return new ComponentRouter(client);
}