// src/events/ready.js
import { Events, ActivityType } from 'discord.js';
import { runDueJobs, cleanupOldJobs, getJobStats } from '../core/db/jobs.js';
import { createLogger } from '../core/logger.js';
import { ensureGuildRow } from '../core/db/guild.js';
import { initializeComponents } from '../components/init.js';
import env from '../core/env-config.js';

const log = createLogger({ mod: 'ready' });

// worker state
let workerInterval = null;
let cleanupInterval = null;
let isProcessing = false;
let runCount = 0;

async function processJobs(client, workerId, batchSize, shouldRun) {
  isProcessing = true;
  runCount++;

  try {
    // If your runDueJobs ignores the 4th arg, that's fine—extra args are harmless.
    const processed = await runDueJobs(client, workerId, batchSize, shouldRun);

    if (processed > 0) {
      log.info({ processed, run: runCount }, 'Processed job batch');
      client.stats && (client.stats.jobsProcessed = (client.stats.jobsProcessed || 0) + processed);
    }

    if (processed > 0 || runCount % 10 === 0) {
      const stats = await getJobStats().catch(() => null);
      if (stats) log.debug({ stats, run: runCount }, 'Job queue status');
    }
  } catch (err) {
    log.error({ err }, 'Job processing error');
    client.stats && (client.stats.jobsFailed = (client.stats.jobsFailed || 0) + 1);
  } finally {
    isProcessing = false;
  }
}

function stopWorker() {
  if (workerInterval) { clearInterval(workerInterval); workerInterval = null; }
  if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
  log.info('Job worker stopped');
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const shardId    = client.shard?.ids?.[0] ?? 0;
    const shardCount = client.shard?.count ?? client.options?.shardCount ?? 1;

    log.info({ id: client.user.id, tag: client.user.tag, shardId, shardCount, pid: process.pid }, 'Client ready');

    // -------- Presence --------
    try {
      const status = process.env.VOID_PRESENCE || 'online'; // online | idle | dnd | invisible
      const text   = process.env.VOID_ACTIVITY_TEXT || null;
      const type   = (process.env.VOID_ACTIVITY_TYPE || 'Watching');

      const typeMap = {
        Playing: ActivityType.Playing,
        Streaming: ActivityType.Streaming,
        Listening: ActivityType.Listening,
        Watching: ActivityType.Watching,
        Competing: ActivityType.Competing,
      };

      if (text) {
        await client.user.setPresence({ status, activities: [{ name: text, type: typeMap[type] ?? ActivityType.Watching }] });
      } else if (shardCount > 1) {
        await client.user.setPresence({
          status: 'online',
          activities: [{ name: `Shard ${shardId + 1}/${shardCount}`, type: ActivityType.Watching }],
        });
      } else {
        await client.user.setPresence({ status });
      }
    } catch (e) {
      log.warn({ err: e?.message }, 'Failed to set presence');
    }

    // -------- Ensure guild rows (per shard) --------
    try {
      const guilds = [...client.guilds.cache.values()];
      await Promise.all(guilds.map(g => ensureGuildRow(g.id)));
      log.info({ count: guilds.length, shardId }, 'Ensured guild_config rows on startup');
    } catch (err) {
      log.error({ err, shardId }, 'Failed to ensure guild rows');
    }

    // -------- Components (idempotent) --------
    try {
      if (!client.components) {
        await initializeComponents(client);
        log.info('Component system ready');
      } else {
        log.info('Component system already initialized (skipped)');
      }
    } catch (err) {
      log.error({ err }, 'Failed to initialize components');
    }

    // -------- Job worker (shard-aware) --------
    const intervalMs = parseInt(process.env.JOB_WORKER_INTERVAL, 10) || 30_000;
    const batchSize  = parseInt(process.env.JOB_BATCH_SIZE, 10) || 10;
    const workerId   = `worker-${process.pid}-${shardId}`;

    // Predicate to ensure only the responsible shard processes a job.
    const ownedByThisShard = (guildId) => {
      if (client.shardRouter?.isResponsibleForGuild) {
        return client.shardRouter.isResponsibleForGuild(guildId);
      }
      // Fallback: snowflake route by modulo (matches Discord’s default).
      try {
        return (BigInt(guildId) >> 22n) % BigInt(shardCount) === BigInt(shardId);
      } catch { return shardId === 0; }
    };

    const shouldRun = (job) => {
      if (job?.guild_id) return ownedByThisShard(job.guild_id);
      // Global/system jobs run on shard 0 only
      return shardId === 0;
    };

    log.info({ workerId, intervalMs, batchSize }, 'Starting job worker');

    client.stats && (client.stats.jobsProcessed = 0, client.stats.jobsFailed = 0);

    const initialStats = await getJobStats().catch(() => null);
    if (initialStats) log.info({ stats: initialStats }, 'Job queue initial state');

    await processJobs(client, workerId, batchSize, shouldRun);

    workerInterval = setInterval(async () => {
      if (isProcessing) return;
      const jitter = Math.random() * 1000; // avoid herd effects
      await new Promise(r => setTimeout(r, jitter));
      await processJobs(client, workerId, batchSize, shouldRun);
    }, intervalMs);

    cleanupInterval = setInterval(async () => {
      try {
        const deleted = await cleanupOldJobs(30);
        if (deleted > 0) log.info({ deleted }, 'Cleaned up old jobs');
      } catch (err) {
        log.error({ err }, 'Failed to cleanup old jobs');
      }
    }, 86_400_000); // 24h

    let metricsTimer = null;
    const metricsEvery = env.METRICS_INTERVAL || 30_000;

    const snapshot = () => {
      const mem = process.memoryUsage();
      return {
        shardId: client.shard?.ids?.[0] ?? 0,
        guilds: client.guilds.cache.size,
        users: client.guilds.cache.reduce((a, g) => a + (g.memberCount || 0), 0),
        channels: client.channels.cache.size,
        ping: client.ws.ping,
        memory: mem.rss,
        heapUsed: mem.heapUsed,
        commands: client.stats?.commandExecs
          ? [...client.stats.commandExecs.values()].reduce((a,b)=>a+b,0)
          : 0,
        errors: client.stats?.errors || 0,
        uptime: client.uptime,
        timestamp: Date.now(),
      };
    };

    if (client.ipc) {
      metricsTimer = setInterval(() => {
        if (!client.isReady()) return;
        client.ipc.send('stats', snapshot());
      }, metricsEvery);
      client.once('destroy', () => clearInterval(metricsTimer));
      log.info({ intervalMs: metricsEvery }, 'Metrics collection started');
    }

    // -------- Shutdown hooks --------
    process.on('SIGINT',  stopWorker);
    process.on('SIGTERM', stopWorker);
    client.once('destroy', stopWorker);
  },
};
