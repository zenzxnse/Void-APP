// src/manager.js
import { ShardingManager, REST, Routes } from "discord.js";
import { createLogger } from "./core/logger.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import env from "./core/env-config.js";
import * as prom from "prom-client";
import {
  AnyInboundToManager,
  StatsMsg,
  BroadcastMsg,
  FetchGuildRes,
  EvalAllRes,
  CacheInvalidate,
  JobNudge,
  SetMaintenance,
  HealthCheckRes,
} from "./infra/ipc-schemas.js";
import { acquireLock } from "./bootstrap/singleton-lock.js";

const log = createLogger({ mod: "manager" });
const __dirname = dirname(fileURLToPath(import.meta.url));

// Prometheus registry
const registry = new prom.Registry();
prom.collectDefaultMetrics({ register: registry, prefix: "void_" });

const gShardStatus = new prom.Gauge({
  name: "discord_shard_status",
  help: "1=ready,0=not-ready",
  labelNames: ["shard_id"],
  registers: [registry],
});
const gShardGuilds = new prom.Gauge({
  name: "discord_shard_guilds",
  help: "guilds per shard",
  labelNames: ["shard_id"],
  registers: [registry],
});
const gShardPing = new prom.Gauge({
  name: "discord_shard_ping_ms",
  help: "ws ping per shard",
  labelNames: ["shard_id"],
  registers: [registry],
});
const cCommands = new prom.Counter({
  name: "discord_commands_executed_total",
  help: "commands executed (shard aggregate)",
  labelNames: ["shard_id"],
  registers: [registry],
});
const cErrors = new prom.Counter({
  name: "discord_command_errors_total",
  help: "command errors (shard aggregate)",
  labelNames: ["shard_id"],
  registers: [registry],
});
const hIPC = new prom.Histogram({
  name: "discord_ipc_duration_seconds",
  help: "ipc round-trip duration",
  labelNames: ["type"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

class VoidShardingManager extends ShardingManager {
  constructor(totalShards) {
    super(join(__dirname, "shard.js"), {
      token: env.VOID_TOKEN,
      totalShards: totalShards,
      shardList: "auto",
      respawn: true,
      respawnDelay: env.SHARD_RESPAWN_DELAY,
      timeout: env.SHARD_SPAWN_TIMEOUT,
      execArgv:
        env.NODE_ENV === "production"
          ? ["--trace-warnings", "--max-old-space-size=512"]
          : [],
      shardArgs: process.argv.slice(2),
    });

    this.shardStats = new Map();
    this.respawnAttempts = new Map();
    this.readyShards = new Set();
    this.startTime = Date.now();

    this.setupEventHandlers();
    this.setupIPC();
  }

  setupEventHandlers() {
    this.on("shardCreate", (shard) => {
      log.info({ shardId: shard.id }, "Launching shard");
      this.respawnAttempts.set(shard.id, 0);

      shard.on("ready", () => {
        this.readyShards.add(shard.id);
        this.respawnAttempts.set(shard.id, 0);
        gShardStatus.set({ shard_id: String(shard.id) }, 1);
      });
      shard.on("disconnect", () => {
        this.readyShards.delete(shard.id);
        gShardStatus.set({ shard_id: String(shard.id) }, 0);
      });
      shard.on("reconnecting", () => { });
      shard.on("death", (cp) => {
        const attempts = this.respawnAttempts.get(shard.id) || 0;
        log.error(
          { shardId: shard.id, exitCode: cp?.exitCode, attempts },
          "Shard died"
        );
        this.readyShards.delete(shard.id);
        gShardStatus.set({ shard_id: String(shard.id) }, 0);
        if (attempts >= env.MAX_RESPAWN_ATTEMPTS)
          log.fatal({ shardId: shard.id }, "Max respawn attempts reached");
        this.respawnAttempts.set(shard.id, attempts + 1);
      });
      shard.on("error", (err) =>
        log.error({ shardId: shard.id, err }, "Shard error")
      );
    });
  }

  setupIPC() {
    this.on("message", (shard, message) => {
      if (!message || typeof message !== "object") return;
      const parsed = AnyInboundToManager.safeParse(message);
      if (!parsed.success) {
        log.warn(
          {
            errors: parsed.error.issues,
            type: message?.type,
            shardId: shard.id,
          },
          "Invalid IPC (to manager)"
        );
        return;
      }

      switch (message.type) {
        case "stats":
          this.handleStatsUpdate(shard, message.data);
          break;
        case "broadcast":
          /* no-op: manager-origin only */ break;
        case "fetchGuildResponse":
          /* request-scoped */ break;
        case "evalAllResponse":
          /* request-scoped */ break;
        case "cacheInvalidate":
          /* fanout-only */ break;
        case "jobNudge":
          /* noop */ break;
        case "setMaintenance":
          /* can only originate from manager */ break;
        case "healthCheckResponse":
          this._lastDeepHealth = {
            ts: Date.now(),
            shardId: shard.id,
            ok: message.ok,
            details: message.details,
          };
          break;
        default:
          log.debug({ t: message.type }, "Unhandled manager IPC");
      }
    });
  }

  handleStatsUpdate(shard, stats) {
    this.shardStats.set(shard.id, { ...stats, lastUpdate: Date.now() });
    gShardGuilds.set({ shard_id: String(shard.id) }, stats.guilds || 0);
    gShardPing.set({ shard_id: String(shard.id) }, stats.ping || 0);
    // counters are monotonic — record deltas if available; here we just inc by snapshot (approx)
    if (stats.commands)
      cCommands.inc({ shard_id: String(shard.id) }, stats.commands);
    if (stats.errors) cErrors.inc({ shard_id: String(shard.id) }, stats.errors);
  }

  async broadcastToShards(message, excludeShardId = null) {
    const promises = [];
    for (const [id, shard] of this.shards) {
      if (excludeShardId !== null && id === excludeShardId) continue;
      promises.push(
        shard.send(message).catch((err) => {
          log.error({ err, shardId: id }, "IPC broadcast send failed");
          return null;
        })
      );
    }
    return Promise.all(promises);
  }

  getAggregatedStats() {
    const now = Date.now();
    const stats = {
      uptime: now - this.startTime,
      totalShards: this.shards.size,
      shards: [],
      totals: {
        guilds: 0,
        users: 0,
        memory: 0,
        ping: 0,
        commands: 0,
        errors: 0,
      },
    };
    let contributing = 0;
    for (const [id, s] of this.shardStats) {
      const stale = !s || now - (s.lastUpdate || 0) > env.READINESS_STALE_MS;
      const ready = this.readyShards.has(id);
      stats.shards.push({
        id,
        status: ready ? "ready" : "not_ready",
        stale,
        ...(s || {}),
      });
      if (!stale && s) {
        contributing++;
        stats.totals.guilds += s.guilds || 0;
        stats.totals.users += s.users || 0;
        stats.totals.memory += s.memory || 0;
        stats.totals.ping += s.ping || 0;
        stats.totals.commands += s.commands || 0;
        stats.totals.errors += s.errors || 0;
      }
    }
    stats.totals.ping = contributing
      ? Math.round(stats.totals.ping / contributing)
      : 0;
    return stats;
  }

  async deepHealthSample(timeoutMs = 3000) {
    const any = [...this.shards.keys()][0];
    if (any == null) return { ok: false, reason: "no shards" };
    const shard = this.shards.get(any);
    const end = hIPC.startTimer({ type: "healthCheck" });
    const res = await shard
      ?.request?.({ type: "healthCheck" })
      .catch(() => null);
    end();
    return res || { ok: false, reason: "no response" };
  }

  async spawn() {
    log.info(
      { totalShards: this.totalShards, spawnDelay: env.SHARD_SPAWN_DELAY },
      "Spawning shards"
    );
    await super.spawn({
      amount: this.totalShards,
      delay: env.SHARD_SPAWN_DELAY,
      timeout: env.SHARD_SPAWN_TIMEOUT,
    });
    log.info("All shards spawned");
  }
}

function setupHealthServer(manager) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.writeHead(200);
      res.end(await registry.metrics());
      return;
    }

    if (req.url === "/metrics.json") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify(manager.getAggregatedStats(), null, 2));
      return;
    }

    if (req.url === "/health/live") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ status: "alive" }));
      return;
    }

    if (req.url === "/health/deep") {
      res.setHeader("Content-Type", "application/json");
      const sample = await manager.deepHealthSample().catch(() => null);
      res.writeHead(sample?.ok ? 200 : 503);
      res.end(JSON.stringify(sample || { ok: false }));
      return;
    }

    if (req.url?.startsWith("/maintenance/")) {
      // /maintenance/on or /maintenance/off (basic, secure behind your reverse-proxy)
      const on = req.url.endsWith("/on");
      manager.broadcastToShards({
        type: "setMaintenance",
        data: { enabled: on },
      });
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ maintenance: on }));
      return;
    }

    if (req.url === "/health/ready") {
      const aggr = manager.getAggregatedStats();
      const allReady =
        manager.readyShards.size === manager.shards.size &&
        aggr.shards.every((s) => !s.stale);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(allReady ? 200 : 503);
      res.end(
        JSON.stringify({
          ready: allReady,
          shards: manager.shards.size,
          readyCount: manager.readyShards.size,
          staleCount: aggr.shards.filter((s) => s.stale).length,
        })
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.on("error", (err) => log.error({ err }, "Health server error"));
  server.listen(env.HEALTH_PORT, () =>
    log.info({ port: env.HEALTH_PORT }, "Health/metrics server listening")
  );
  return server;
}

function setupShutdownHandlers(manager, healthServer) {
  let shutting = false;
  const shutdown = async (signal) => {
    if (shutting) return;
    shutting = true;
    try {
      await client.autoMod?.close?.();
    } catch { }
    log.info({ signal }, "Manager shutting down");
    try {
      healthServer.close();
    } catch { }
    try {
      await Promise.all(
        [...manager.shards.values()].map((s) =>
          s.send({ type: "shutdown" }).catch(() => { })
        )
      );
      await new Promise((r) => setTimeout(r, 5000));
      for (const s of manager.shards.values()) {
        try {
          s.kill();
        } catch { }
      }
    } catch (err) {
      log.error({ err }, "Shutdown error");
    }
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export async function computeShardCount() {
  // Honor explicit override (string or number)
  if (env.TOTAL_SHARDS != null && !Number.isNaN(Number(env.TOTAL_SHARDS))) {
    const forced = Number(env.TOTAL_SHARDS);
    console.log("[sharding] forced TOTAL_SHARDS =", forced);
    return Math.max(1, forced);
  }

  // --- START: CORRECTED CODE ---
  // Use the REST client to fetch gateway info from Discord
  const rest = new REST({ version: '10' }).setToken(env.VOID_TOKEN);
  const data = await rest.get(Routes.gatewayBot());

  // The recommended shard count is in the 'shards' property
  const recommended = data.shards;
  // --- END: CORRECTED CODE ---

  // Policy knobs (your existing logic)
  const HEADROOM_PCT = Number(process.env.SHARD_HEADROOM_PCT ?? 0);
  const MIN_SHARDS   = Number(process.env.MIN_SHARDS ?? 1);
  const MAX_SHARDS   = Number(process.env.MAX_SHARDS ?? 128);

  // Apply headroom only when we’re already at ≥2 shards
  const withHeadroom = recommended >= 2
    ? Math.ceil(recommended * (1 + HEADROOM_PCT / 100))
    : recommended;

  const count = Math.min(Math.max(withHeadroom, MIN_SHARDS), MAX_SHARDS);

  console.log("[sharding] recommended =", recommended,
              "headroom% =", HEADROOM_PCT, "final =", count);

  return count;
}

async function main() {
  await acquireLock("manager");
  const totalShards = await computeShardCount();

  log.info(
    { node: process.version, env: env.NODE_ENV, totalShards },
    "Starting manager"
  );

  const manager = new VoidShardingManager(totalShards);
  const server = setupHealthServer(manager);
  setupShutdownHandlers(manager, server);
  await manager.spawn();
}

main().catch((err) => {
  log.fatal({ err }, "Manager failed to start");
  process.exit(1);
});

// docker run --name void-redis -p 6379:6379 -d redis:7-alpine

/*
$src="C:\Mods\Java Notes\mc\New folder\Void"; `
$pkg="$env:TEMP\void-upload.tgz"; `
if(Test-Path $pkg){Remove-Item $pkg -Force}; `
tar -czf "$pkg" -C "$src" --exclude=node_modules --exclude=.git --exclude=.env --exclude=.DS_Store .; `
scp "$pkg" root@89.116.191.107:/opt/void-bot/void-upload.tgz; `
ssh root@89.116.191.107 "cd /opt/void-bot && tar xzf void-upload.tgz -C app && rm void-upload.tgz && echo 'Synced.'"

*/