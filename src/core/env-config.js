// src/core/env-config.js
import 'dotenv/config';
import { z } from 'zod';

const Int = (def) => z.coerce.number().int().nonnegative().default(def);
const Bool = (def) => z
  .string()
  .transform(v => /^(1|true|yes)$/i.test(v))
  .optional()
  .transform(v => (v === undefined ? def : v));

const schema = z.object({
  VOID_TOKEN: z.string().min(1, 'VOID_TOKEN is required'),
  NODE_ENV: z.enum(['production','development']).default(process.env.NODE_ENV ?? 'development'),

  // Sharding
  SHARDING: z.string().optional(),               // '0' or '1' (string env)
  TOTAL_SHARDS: z.string().optional(),           // 'auto' or int
  SHARD_SPAWN_DELAY: Int(7500),
  SHARD_SPAWN_TIMEOUT: Int(30000),
  SHARD_RESPAWN_DELAY: Int(5000),
  MAX_RESPAWN_ATTEMPTS: Int(5),

  // Health / Metrics
  HEALTH_PORT: Int(3001),
  METRICS_INTERVAL: Int(30000),
  READINESS_STALE_MS: Int(90000),

  // Jobs
  JOB_INTERVAL: Int(30000),
  JOB_BATCH_SIZE: Int(10),

  // Redis
  REDIS_URL: z.string().default('redis://127.0.0.1:6379/0'),
  REDIS_KEY_PREFIX: z.string().default('void:'),
  REDIS_LIMP_MODE: Bool(true), // allow limp fallback if redis down

  // Logging (env wins over app config; your logger already reads these)
  LOG_LEVEL: z.string().optional(),
  LOG: z.string().optional(),
  LOG_PRETTY: z.string().optional(),
  LOG_JSON: z.string().optional(),
  LOG_COLOR: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Pretty-print the first handful of issues then bail
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues.slice(0, 10)) {
    console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// derive shouldShard default: shard in prod unless SHARDING='0'
const shouldShard = env.SHARDING != null
  ? env.SHARDING !== '0'
  : env.NODE_ENV === 'production';

// derive totalShards normalized
const totalShards =
  (env.TOTAL_SHARDS?.toLowerCase?.() === 'auto')
    ? 'auto'
    : (Number.isFinite(parseInt(env.TOTAL_SHARDS)) ? parseInt(env.TOTAL_SHARDS) : 'auto');

export default {
  ...env,
  SHOULD_SHARD: shouldShard,
  TOTAL_SHARDS: totalShards,
};
