// src/core/logger.js
import pino from 'pino';
import { createRequire } from 'node:module';
import config from './config.js';

const require = createRequire(import.meta.url);

const nodeEnv   = process.env.NODE_ENV ?? config.NODE_ENV ?? 'development';
const isProd    = nodeEnv === 'production';

// level: env > config > default
let level = (process.env.LOG_LEVEL ?? config.LOG_LEVEL ?? (isProd ? 'info' : 'debug')).toLowerCase();
// allow "LOG=0/1" toggle (your quick boolean)
if (process.env.LOG === '0' || process.env.LOG === 'false') level = 'silent';
if (process.env.LOG === '1' && level === 'silent') level = 'info';

const redactPaths = (process.env.LOG_REDACT ?? config.LOG_REDACT ?? '')
  .split(/[,\s]+/)
  .map(s => s.trim())
  .filter(Boolean);

// pretty control
const forcePretty  = /^(1|true|yes)$/i.test(process.env.LOG_PRETTY ?? '');
const forceJson    = /^(1|true|yes)$/i.test(process.env.LOG_JSON ?? '');
const colorize     = !/^(0|false|no)$/i.test(process.env.LOG_COLOR ?? '1');

let hasPretty = false;
if (!isProd || forcePretty) {
  try { require.resolve('pino-pretty'); hasPretty = true; } catch { hasPretty = false; }
}

const base = {
  level,
  timestamp: isProd ? pino.stdTimeFunctions.isoTime : undefined,
  redact: redactPaths.length ? { paths: redactPaths, censor: '[Redacted]' } : undefined,
};

const options = (!forceJson && hasPretty && process.stdout.isTTY)
  ? {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          // add shard/role if present in child bindings
          messageFormat: '{proc} {mod} > {msg}',
        },
      },
    }
  : base;

export const logger = pino(options);

export function createLogger(bindings = {}) {
  // auto-proc tag if not provided
  const proc =
    process.env.SHARD_LIST || process.env.SHARD_ID
      ? `shard:${process.env.SHARD_LIST ?? process.env.SHARD_ID}`
      : (process.env.MANAGER ? 'manager' : 'proc');
  return logger.child({ proc, ...bindings });
}

export function forInteraction(interaction) {
  try {
    const meta = {
      interactionId: interaction?.id ?? null,
      type: interaction?.type ?? null,
      isDM: interaction?.inGuild ? !interaction.inGuild() : null,
      guildId: interaction?.guildId ?? null,
      channelId: interaction?.channelId ?? null,
      userId: interaction?.user?.id ?? null,
      locale: interaction?.locale ?? null,
      customId: interaction?.customId ?? null,
      commandName: interaction?.commandName ?? null,
    };
    return logger.child(meta);
  } catch {
    return logger;
  }
}
