// ============================================================================
// COMPONENT ROUTER FINAL - PRODUCTION READY
// Complete implementation with persistence and all fixes
// ============================================================================

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
// ============================================================================

class AntiReplayGuard {
  constructor() {
    this.used = new Map(); // key -> expiryTs
    this.lastGC = Date.now();
  }

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

export class SecureCustomId {
  constructor(namespace, action, version = 'v1') {
    this.namespace = namespace;
    this.action = action;
    this.version = version;
    this.data = {};
  }

  setContext(interaction) {
    this.data.u = interaction.user.id;
    this.data.g = interaction.guildId || 'd';
    this.data.c = interaction.channelId;
    this.data.m = interaction.message?.id || null;
    this.data.e = Math.floor(Date.now() / 1000) + CONFIG.DEFAULT_TTL;
    this.data.n = randomBytes(6).toString('hex');
    return this;
  }

  setData(custom) {
    this.data.d = custom;
    return this;
  }

  setTTL(seconds) {
    this.data.e = Math.floor(Date.now() / 1000) + seconds;
    return this;
  }

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

// Helper for cleaner code
export function makeId(ns, action, interaction, custom = {}, ttl = CONFIG.DEFAULT_TTL) {
  return new SecureCustomId(ns, action)
    .setContext(interaction)
    .setData(custom)
    .setTTL(ttl)
    .build();
}

// ============================================================================
// GUILD CONFIG CACHE WITH INVALIDATION
// ============================================================================

class GuildConfigCache {
  constructor() {
    this.cache = new Map();
    this.promises = new Map();
  }

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

  set(guildId, data) {
    this.cache.set(guildId, {
      data,
      expires: Date.now() + CONFIG.GUILD_CACHE_TTL
    });
  }

  invalidate(guildId) {
    this.cache.delete(guildId);
    this.promises.delete(guildId);
    log.debug({ guildId }, 'Guild config cache invalidated');
  }

  clear() {
    this.cache.clear();
    this.promises.clear();
  }
}

// ============================================================================
// COMPONENT REGISTRY
// ============================================================================

class ComponentRegistry {
  constructor(type) {
    this.type = type;
    this.handlers = new Map();
    this.patterns = [];
  }

  register(key, handler) {
    this.handlers.set(key, this.normalizeHandler(handler));
    return this;
  }

  registerPattern(pattern, handler) {
    this.patterns.push({
      pattern,
      handler: this.normalizeHandler(handler)
    });
    return this;
  }

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
      ephemeral: handler.ephemeral ?? true,
      callerOnly: handler.callerOnly ?? false,
      allowedUsers: handler.allowedUsers ? new Set(handler.allowedUsers) : null,
      allowedRoles: handler.allowedRoles ? new Set(handler.allowedRoles) : null,
      skipGuildConfig: handler.skipGuildConfig ?? false,
      persistent: handler.persistent ?? false,
    };
  }
}

// ============================================================================
// COMPONENT MIDDLEWARE
// ============================================================================

class ComponentMiddleware {
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

  static checkCallerOnly(interaction, handler, parsed) {
    if (!handler.callerOnly) return true;
    
    if (parsed?.data?.userId) {
      return interaction.user.id === parsed.data.userId;
    }
    
    const originalUser = interaction.message?.interaction?.user;
    return !originalUser || interaction.user.id === originalUser.id;
  }

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

export class ComponentRouter {
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

  // Registration methods
  button(key, handler) {
    this.registries.get('button').register(key, handler);
    return this;
  }

  stringSelect(key, handler) {
    this.registries.get('string_select').register(key, handler);
    return this;
  }

  userSelect(key, handler) {
    this.registries.get('user_select').register(key, handler);
    return this;
  }

  roleSelect(key, handler) {
    this.registries.get('role_select').register(key, handler);
    return this;
  }

  mentionableSelect(key, handler) {
    this.registries.get('mentionable_select').register(key, handler);
    return this;
  }

  channelSelect(key, handler) {
    this.registries.get('channel_select').register(key, handler);
    return this;
  }

  modal(key, handler) {
    this.registries.get('modal').register(key, handler);
    return this;
  }

  /**
   * Install listeners
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

  isComponent(interaction) {
    return interaction.isButton() ||
           interaction.isAnySelectMenu() ||
           interaction.isModalSubmit();
  }

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
      
      // Anti-replay check
      const replayKey = `${parsed.versionedPrefix}:${parsed.data.guildId}:${parsed.data.messageId}:${parsed.data.nonce}`;
      if (!antiReplay.check(replayKey)) {
        this.incrementDenial('replay');
        await this.replyError(interaction, 'This action was already used.');
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
   * Store persistent component metadata
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
                     expires_at   = EXCLUDED.expires_at`,
      [
        interaction.message.id,
        interaction.channelId,
        interaction.guildId || null,                              // DM-safe
        `${parsed.namespace}:${parsed.action}`,                   // unversioned
        key,                                                      // stable
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
   */
  async replyError(interaction, message) {
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: message, ephemeral: true });
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.followUp({ content: message, ephemeral: true });
      }
    } catch (err) {
      log.debug({ err }, 'Failed to send error reply');
    }
  }

  /**
   * Increment denial counter
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
   * Invalidate guild cache
   */
  invalidateGuildCache(guildId) {
    this.guildConfigCache.invalidate(guildId);
  }

  /**
   * Get detailed statistics
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

// ============================================================================
// FACTORY
// ============================================================================

export default function createComponentRouter(client) {
  return new ComponentRouter(client);
}