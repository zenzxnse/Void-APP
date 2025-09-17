import config from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ mod: 'bootstrap:error-traps' });
const isProd = String(config.NODE_ENV || 'development').toLowerCase() === 'production';

function asErr(x) {
  if (x instanceof Error) return x;
  // Preserve message/stack-like fields if present
  const msg = typeof x === 'string' ? x : JSON.stringify(x, null, 2);
  const e = new Error(msg);
  // attach original for Pino serializers
  e.original = x;
  return e;
}

if (process.listenerCount('unhandledRejection') === 0) {
  process.on('unhandledRejection', (reason, promise) => {
    log.error({ err: asErr(reason), promiseType: promise?.constructor?.name }, 'unhandledRejection');
  });
}

if (process.listenerCount('uncaughtException') === 0) {
  process.on('uncaughtException', (err) => {
    log.fatal({ err: asErr(err) }, 'uncaughtException');
    if (isProd) process.exit(1); // crash-fast in prod; keep alive in dev
  });
}
