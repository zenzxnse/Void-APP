// src/shard.js
import { Events, ActivityType } from "discord.js";
import VoidApp from "./core/VoidApp.js";
import "./bootstrap/error-traps.js";
import "dotenv/config";
import { acquireLock } from "./bootstrap/singleton-lock.js";
import { initDb } from "./core/db/index.js";
import { ensureGuildRow } from "./core/db/guild.js";
import { initializeComponents } from "./components/init.js";
import { runDueJobs, cleanupOldJobs } from "./core/db/jobs.js";
import { createLogger } from "./core/logger.js";
import { ShardIPC } from "./infra/ipc.js";
import { ShardRouter } from "./infra/shard-routing.js";
import env from "./core/env-config.js";
import {
  initRedis,
  attachRedisTo,
  getRedisClient,
  redisAvailable,
} from "./infra/redis.js";
import { createAutoModState } from "./utils/automod/redis-state.js";

const log = createLogger({ mod: "shard" });

// This is the new, robust startup sequence for a shard process.
export async function runShard() {
  const isManaged = !!process.send;

  // 1. Instantiate the client. When spawned by ShardingManager,
  //    discord.js automatically reads process.env and configures the client's shard options.
  const Void = new VoidApp(process.env.VOID_TOKEN);

  // 2. We can now reliably get the shard ID and count directly from the client's options,
  //    which have been correctly populated by the manager. This avoids parsing process.env ourselves.
  const shardId = Void.options.shards[0]; // This is the ID for this specific process
  const shardCount = Void.options.shardCount;
  const cfg = { shardId, shardCount, managerMode: isManaged };

  log.info({ ...cfg }, "Starting shard");
  try {
    process.title = `void-bot:shard:${cfg.shardId}/${cfg.shardCount}`;
  } catch {}

  process.env.PG_MAX = process.env.PG_MAX || "5";

  // 3. Use the reliable shardId to acquire a unique lock. This resolves the crash.
  try {
    await acquireLock(`db-init-shard-${cfg.shardId}`);
    await initDb();
    log.info("Database initialized");
  } catch (err) {
    log.fatal({ err }, `DB init failed for shard ${cfg.shardId}`);
    process.exit(1);
  }

  await initRedis().catch((err) => {
    log.error({ err }, "Redis init failed");
    process.exit(1);
  });

  // Attach helpers and other properties to our client instance
  Void.shardInfo = {
    id: cfg.shardId,
    count: cfg.shardCount,
    managed: cfg.managerMode,
  };
  attachRedisTo(Void); // Void.redis.* helpers
  Void.isMaintenanceMode = false;

  // ---- AutoMod state (requires raw ioredis client) ----
  if (redisAvailable()) {
    const rawRedis = getRedisClient();
    const autoModState = createAutoModState(rawRedis);
    Void.autoMod = autoModState; // convenient handle if you want it elsewhere
    await autoModState.subscribeToInvalidations((data) => {
      log.debug({ data }, "automod: invalidation received");
    });
    log.info("AutoMod state initialized");
  } else {
    log.warn("Redis unavailable → AutoMod disabled (limp mode).");
  }

  // Health check methods for the manager's deep probe
  Void.healthDetails = async () => {
    const wsReady = Void.ws?.status === 0;
    let db = false,
      redis = false;
    try {
      await initDb();
      db = true;
    } catch {}
    try {
      const pong = await Void.redis.ping();
      redis = !!pong;
    } catch {}
    return { wsReady, db, redis };
  };
  Void.healthCheck = async () => {
    const d = await Void.healthDetails();
    return d.wsReady && d.db && d.redis;
  };

  // Setup IPC and ShardRouter with the correct config
  let ipc = null;
  if (cfg.managerMode) {
    ipc = new ShardIPC(Void, cfg);
    Void.ipc = ipc;
  }
  const router = new ShardRouter(cfg.shardId, cfg.shardCount);
  Void.shardRouter = router;

  // These handlers are for general client events like 'guildCreate'
  setupShardEvents(Void, cfg, ipc);

  // Setup graceful shutdown handlers for the process
  setupShutdownHandlers(Void, ipc);

  // Finally, login to Discord to bring the shard online
  await Void.start();

  return Void;
}

/**
 * [DEPRECATED]
 * Sets up the consolidated 'ready' event handler. All logic that should run once
 * the shard is connected and ready should be placed here.
 */
function setupReadyHandler(client, cfg, ipc, router) {
  client.once(Events.ClientReady, async (readyClient) => {
    log.info(
      {
        id: readyClient.user.id,
        tag: readyClient.user.tag,
        shardId: cfg.shardId,
      },
      "Shard client is ready"
    );

    // Set presence from environment variables or default to shard status
    try {
      const status = env.VOID_PRESENCE || "online";
      const text = env.VOID_ACTIVITY_TEXT;
      const typeName = env.VOID_ACTIVITY_TYPE || "Watching";

      if (text) {
        const typeMap = {
          Playing: 0,
          Streaming: 1,
          Listening: 2,
          Watching: 3,
          Competing: 5,
        };
        await client.user.setPresence({
          status,
          activities: [{ name: text, type: typeMap[typeName] ?? 3 }],
        });
      } else if (cfg.shardCount > 1) {
        await client.user.setPresence({
          status: "online",
          activities: [
            {
              name: `Shard ${cfg.shardId + 1}/${cfg.shardCount}`,
              type: ActivityType.Watching,
            },
          ],
        });
      }
    } catch (e) {
      log.warn({ err: e?.message }, "Failed to set presence");
    }

    // Ensure all guilds this shard is responsible for have a row in the database
    try {
      const guilds = [...client.guilds.cache.values()];
      await Promise.all(guilds.map((g) => ensureGuildRow(g.id)));
      log.info(
        { count: guilds.length, shardId: cfg.shardId },
        "Ensured guild_config rows"
      );
    } catch (err) {
      log.error({ err, shardId: cfg.shardId }, "Failed to ensure guild rows");
    }
    startShardJobWorker(client, router);
    if (ipc) {
      startMetricsCollection(client, ipc);

      // Initialize interactive components (buttons, modals, etc.)
      await initializeComponents(client);

      // Start background workers now that the client is ready
    }
  });
}

function setupShardEvents(client, cfg, ipc) {
  client.on(Events.GuildCreate, (g) => {
    log.info(
      { guildId: g.id, guildName: g.name, shard: cfg.shardId },
      "Joined guild"
    );
    ipc?.send("guildUpdate", {
      action: "join",
      guild: { id: g.id, name: g.name },
    });
  });
  client.on(Events.GuildDelete, (g) => {
    log.info(
      { guildId: g.id, guildName: g.name, shard: cfg.shardId },
      "Left guild"
    );
    ipc?.send("guildUpdate", {
      action: "leave",
      guild: { id: g.id, name: g.name },
    });
  });
  client.on(Events.ShardError, (err, shardId) =>
    log.error({ err, shardId }, "Shard WS error")
  );
  client.on(Events.ShardResume, (shardId) =>
    log.info({ shardId }, "Shard resumed")
  );
  client.on(Events.ShardDisconnect, (_, shardId) =>
    log.warn({ shardId }, "Shard disconnected")
  );
}

function startShardJobWorker(client, router) {
  const workerId = `shard-${client.shard.id}-${process.pid}`;
  const intervalMs = env.JOB_INTERVAL;
  const batchSize = env.JOB_BATCH_SIZE;
  let running = false;

  const processJobs = async () => {
    if (running || client.isMaintenanceMode) return;
    running = true;
    try {
      const processed = await runDueJobs(client, workerId, batchSize, (job) => {
        if (job.guild_id) return router.isResponsibleForGuild(job.guild_id);
        return client.shard.id === 0; // System jobs run on shard 0
      });
      if (processed > 0) log.info({ processed, workerId }, "Processed jobs");
    } catch (err) {
      log.error({ err, workerId }, "Job processing error");
    } finally {
      running = false;
    }
  };

  processJobs(); // Initial run
  const workerInterval = setInterval(processJobs, intervalMs);

  if (client.shard.id === 0) {
    const cleanupInterval = setInterval(async () => {
      try {
        const del = await cleanupOldJobs(30);
        if (del > 0) log.info({ deleted: del }, "Cleaned old jobs");
      } catch (err) {
        log.error({ err }, "Cleanup error");
      }
    }, 86_400_000); // 24 hours
    client.once("destroy", () => clearInterval(cleanupInterval));
  }

  client.once("destroy", () => clearInterval(workerInterval));
  if (process.send) {
    process.on("message", (msg) => {
      if (msg?.type === "jobNudge") processJobs();
    });
  }

  log.info({ workerId, intervalMs, batchSize }, "Job worker started");
}

function startMetricsCollection(client, ipc) {
  const intervalMs = env.METRICS_INTERVAL;
  const collect = () => {
    if (!client.isReady()) return;
    const mem = process.memoryUsage();
    const stats = {
      shardId: client.shard.id,
      guilds: client.guilds.cache.size,
      users: client.guilds.cache.reduce(
        (acc, guild) => acc + guild.memberCount,
        0
      ),
      channels: client.channels.cache.size,
      ping: client.ws.ping,
      memory: mem.rss,
      heapUsed: mem.heapUsed,
      commands: 0, // Your stats bucket needs to be initialized
      errors: 0, // Your stats bucket needs to be initialized
      uptime: client.uptime,
      timestamp: Date.now(),
    };
    ipc.send("stats", stats);
  };
  const t = setInterval(collect, intervalMs);
  client.once("destroy", () => clearInterval(t));
  log.info({ intervalMs }, "Metrics collection started");
}

function setupShutdownHandlers(client, ipc) {
  let shutting = false;
  const shutdown = async (signal) => {
    if (shutting) return;
    shutting = true;
    log.info({ signal, shard: client.shard.id }, "Shard shutting down");
    try {
      ipc?.send("shutdown", { shard: client.shard.id });
    } catch {}
    try {
      await client.destroy();
    } catch (err) {
      log.error({ err }, "Destroy error");
    }
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  if (process.send)
    process.on("message", (msg) => {
      if (msg?.type === "shutdown") shutdown("MANAGER");
    });
  process.on("uncaughtException", (err) => {
    log.fatal({ err, shard: client.shard.id }, "Uncaught");
    shutdown("UNCAUGHT_EXCEPTION");
  });
  process.on("unhandledRejection", (reason) => {
    log.error({ reason, shard: client.shard.id }, "Unhandled rejection");
  });
}

runShard().catch((err) => {
  log.fatal({ err }, "Shard start failed");
  process.exit(1);
});
