// src/infra/ipc.js
import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'node:events';
import {
  AnyInboundToShard,
  AnyInboundToManager,
  FetchGuildReq,
  EvalAllReq,
  CacheInvalidate,
  SetMaintenance,
  HealthCheckReq,
} from './ipc-schemas.js';

const log = createLogger({ mod: 'ipc' });

export class ShardIPC extends EventEmitter {
  constructor(client, shardConfig) {
    super();
    this.client = client;
    this.shardId = shardConfig.shardId;
    this.shardCount = shardConfig.shardCount;
    this.promises = new Map();
    this.nonceCounter = 0;

    this.setupMessageHandler();
  }

  setupMessageHandler() {
    if (!process.send) {
      log.warn('No IPC channel (standalone)');
      return;
    }

    process.on('message', message => {
      if (!message || typeof message !== 'object') return;

      // resolve request/response
      if (message.nonce && this.promises.has(message.nonce)) {
        const { resolve, reject } = this.promises.get(message.nonce);
        this.promises.delete(message.nonce);
        if (message.error) reject(new Error(message.error));
        else resolve(message.data ?? message);
        return;
      }

      // validate
      const parsed = AnyInboundToShard.safeParse(message);
      if (!parsed.success) {
        log.warn({ errors: parsed.error.issues, type: message?.type }, 'Invalid IPC message (to shard)');
        return;
      }

      // built-in handlers
      switch (message.type) {
        case 'cacheInvalidate':
          this.handleCacheInvalidate(message.data);
          break;
        case 'evalAll':
        case 'eval':         // tolerance for manager mislabel
          this.handleEval(message);
          break;
        case 'fetchGuild':
          this.handleFetchGuild(message);
          break;
        case 'broadcast':
          this.handleBroadcast(message);
          break;
        case 'jobNudge':
          this.emit('jobNudge');
          break;
        case 'setMaintenance':
          this.client.isMaintenanceMode = !!message.data?.enabled;
          log.warn({ enabled: this.client.isMaintenanceMode }, 'Maintenance mode toggled');
          this.emit('maintenance', this.client.isMaintenanceMode);
          break;
        case 'healthCheck':
          this.handleHealthCheck(message);
          break;
        default:
          // ignore
          break;
      }
    });
  }

  // SEND / REQUEST

  send(type, data = {}) {
    if (!process.send) return false;
    try { process.send({ type, data }); return true; }
    catch (err) { log.error({ err, type }, 'IPC send failed'); return false; }
  }

  async request(type, data, timeout = 5000) {
    if (!process.send) throw new Error('No IPC');
    const nonce = `${this.shardId}-${++this.nonceCounter}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.promises.delete(nonce);
        reject(new Error(`IPC request timeout: ${type}`));
      }, timeout);
      this.promises.set(nonce, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      process.send({ type, data, nonce });
    });
  }

  // HANDLERS

  handleCacheInvalidate(data) {
    this.emit('cacheInvalidate', data);
    // Hook your local caches if needed (e.g., guildConfig local map)
    if (this.client.components?.invalidateGuildCache && data?.type === 'guild' && data?.key) {
      try { this.client.components.invalidateGuildCache(data.key); } catch {}
    }
  }

  async handleEval(message) {
    const parsed = EvalAllReq.safeParse(message);
    const nonce = message?.nonce;
    if (!parsed.success) {
      if (nonce && process.send) process.send({ type: 'evalResponse', nonce, error: 'invalid eval payload' });
      return;
    }
    try {
      // eslint-disable-next-line no-eval
      const result = await eval(parsed.data.code);
      if (nonce && process.send) process.send({ type: 'evalResponse', nonce, data: result });
    } catch (err) {
      if (nonce && process.send) process.send({ type: 'evalResponse', nonce, error: err.message });
    }
  }

  async handleFetchGuild(message) {
    const parsed = FetchGuildReq.safeParse(message);
    const nonce = message?.nonce;
    if (!parsed.success) {
      if (nonce && process.send) process.send({ type: 'fetchGuildResponse', nonce, error: 'invalid payload' });
      return;
    }
    const { guildId } = parsed.data;
    const g = this.client.guilds.cache.get(guildId);
    if (nonce && process.send) {
      process.send({
        type: 'fetchGuildResponse',
        nonce,
        data: g ? { id: g.id, name: g.name, memberCount: g.memberCount, ownerId: g.ownerId, shardId: this.shardId } : null,
      });
    }
  }

  handleBroadcast(message) {
    this.emit('broadcast', message.data);
  }

  async handleHealthCheck(message) {
    const parsed = HealthCheckReq.safeParse(message);
    const nonce = message?.nonce;
    if (!parsed.success) {
      if (nonce && process.send) process.send({ type: 'healthCheckResponse', nonce, ok: false, details: { wsReady: false, db: false, redis: false, shardId: this.shardId, ts: Date.now() } });
      return;
    }
    const ok = await this.client.healthCheck?.();
    const details = await this.client.healthDetails?.();
    if (nonce && process.send) {
      process.send({ type: 'healthCheckResponse', nonce, ok: !!ok, details: { ...details, shardId: this.shardId, ts: Date.now() } });
    }
  }
}

export class ManagerIPC {
  constructor(manager) {
    this.manager = manager;
  }
}
