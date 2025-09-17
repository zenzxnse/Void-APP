// src/bootstrap/singleton-lock.js
import { open, unlink, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const heldLocks = new Map(); // path -> filehandle

/** Best-effort: returns true if a PID appears to be running (Windows-friendly). */
function pidLooksAlive(pid) {
  try {
    process.kill(pid, 0); // ESRCH/EINVAL => not running
    return true;
  } catch (e) {
    return !(e && (e.code === 'ESRCH' || e.code === 'EINVAL'));
  }
}

function resolveName(name) {
  let n = name || 'void';

  // If running under the sharding manager and someone requests the default "void",
  // rewrite to a shard-local name to avoid cross-child contention.
  const isManaged = !!process.send || process.env.SHARDING_MANAGER === 'true';
  if (isManaged && (n === 'void' || n === 'instance')) {
    const shardHint = process.env.SHARD_LIST ?? process.env.SHARD_ID ?? '0';
    n = `void-shard-${shardHint}`;
  }

  return n;
}

function lockPathFromName(name) {
  const safe = String(name).replace(/[^\w.-]+/g, '_');
  // One lock file per name, at project root:
  return join(DIR, `../../.void.${safe}.lock`);
}

/**
 * Acquire a named singleton lock.
 *
 * Usage:
 *   await acquireLock('manager');
 *   await acquireLock('instance-shard-0');
 *   await acquireLock({ name: 'db-init-shard-0', force: true });
 */
export async function acquireLock(nameOrOpts, maybeOpts) {
  let name = 'void';
  let force = false;
  
  if (typeof nameOrOpts === 'string') {
    name = nameOrOpts;
    force = !!maybeOpts?.force;
  } else if (nameOrOpts && typeof nameOrOpts === 'object') {
    ({ name = 'void', force = false } = nameOrOpts);
  }

  name = resolveName(name);
  const LOCK_PATH = lockPathFromName(name);

  if (force) {
    try { await unlink(LOCK_PATH); } catch {}
  }

  try {
    const fh = await open(LOCK_PATH, 'wx');         // create exclusively
    await fh.writeFile(String(process.pid));        // write pid
    await fh.sync?.();
    heldLocks.set(LOCK_PATH, fh);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      console.error('[FATAL] Failed to acquire lock:', { name, err });
      process.exit(1);
    }

    // Lock exists — stale or live?
    try {
      const buf = await readFile(LOCK_PATH);
      const text = buf.toString('utf8').trim();
      const pid = Number.parseInt(text, 10);

      const invalid = Number.isNaN(pid) || pid <= 0;
      const { mtimeMs } = await stat(LOCK_PATH).catch(() => ({ mtimeMs: Date.now() }));
      const tooOld = (Date.now() - mtimeMs) > 24 * 60 * 60 * 1000; // 24h

      if (invalid || tooOld || !pidLooksAlive(pid)) {
        console.warn('[WARN] Stale lock file detected — removing.', { name, pid, tooOld, invalid });
        try { await unlink(LOCK_PATH); } catch {}
        // retry once
        return acquireLock(name, { force: false });
      }

      console.error(`[FATAL] Another Void instance is holding "${name}" (PID ${pid}).`);
      process.exit(1);
    } catch (checkErr) {
      console.warn('[WARN] Corrupt lock file — removing.', { name, err: checkErr?.message });
      try { await unlink(LOCK_PATH); } catch {}
      return acquireLock(name, { force: false });
    }
  }

  // Install a one-time process exit cleanup (idempotent)
  if (!process.__void_lock_cleanup_installed) {
    const cleanup = async () => {
      for (const [path, fh] of heldLocks) {
        try { await fh?.close(); } catch {}
        try { await unlink(path); } catch {}
      }
      heldLocks.clear();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { cleanup().finally(() => process.exit(0)); });
    process.__void_lock_cleanup_installed = true;
  }
}
