// src/infra/ipc-schemas.js
import { z } from 'zod';

// shared primitives
const ShardId = z.number().int().nonnegative();

export const StatsMsg = z.object({
  type: z.literal('stats'),
  data: z.object({
    shardId: ShardId,
    guilds: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
    ping: z.number().int().nonnegative(),
    memory: z.number().int().nonnegative(),
    heapUsed: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    uptime: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
  }),
});

export const BroadcastMsg = z.object({
  type: z.literal('broadcast'),
  data: z.record(z.any()),
  nonce: z.string().optional(),
});

export const FetchGuildReq = z.object({
  type: z.literal('fetchGuild'),
  guildId: z.string(),
  nonce: z.string(),
});
export const FetchGuildRes = z.object({
  type: z.literal('fetchGuildResponse'),
  nonce: z.string(),
  data: z.object({
    id: z.string(),
    name: z.string(),
    memberCount: z.number().int().nonnegative(),
    shardId: ShardId.optional(),
    ownerId: z.string().optional(),
  }).nullable().optional(),
  error: z.string().optional(),
});

export const EvalAllReq = z.object({
  type: z.literal('evalAll'),
  nonce: z.string(),
  code: z.any(),
});
export const EvalAllRes = z.object({
  type: z.literal('evalAllResponse'),
  nonce: z.string(),
  data: z.any().optional(),
  error: z.string().optional(),
});

export const CacheInvalidate = z.object({
  type: z.literal('cacheInvalidate'),
  data: z.object({
    type: z.enum(['guild','config','other']).optional(),
    key: z.string().optional(),
  }).optional(),
});

export const JobNudge = z.object({ type: z.literal('jobNudge') });

export const SetMaintenance = z.object({
  type: z.literal('setMaintenance'),
  data: z.object({ enabled: z.boolean() }),
});

export const HealthCheckReq = z.object({
  type: z.literal('healthCheck'),
  nonce: z.string(),
});
export const HealthCheckRes = z.object({
  type: z.literal('healthCheckResponse'),
  nonce: z.string(),
  ok: z.boolean(),
  details: z.object({
    wsReady: z.boolean(),
    db: z.boolean(),
    redis: z.boolean(),
    shardId: ShardId,
    ts: z.number(),
  }),
});

// a union for quick guard
export const AnyInboundToManager = z.union([
  StatsMsg, BroadcastMsg, FetchGuildRes, EvalAllRes, CacheInvalidate, JobNudge, SetMaintenance, HealthCheckRes,
]);

export const AnyInboundToShard = z.union([
  BroadcastMsg, FetchGuildReq, EvalAllReq, CacheInvalidate, JobNudge, SetMaintenance, HealthCheckReq,
]);
