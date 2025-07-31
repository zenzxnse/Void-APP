import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { Collection } from 'discord.js';
import pLimit from 'p-limit';
import config from './config.js';

const EXTS = new Set(['.js', '.mjs', '.cjs']);
const importLimit = pLimit(10);

export default async function loadEvents(
  client,
  dir = new URL(`../${config.EVENTS_FOLDER}/`, import.meta.url),
) {
  // Map<string, Set<Function>> so we can support multiple handlers per event
  client.events = new Collection();
  await scan(dir, client);
  console.log(`[INFO] REGISTRY COMPLETE: ${totalHandlers(client)} event handler(s) across ${client.events.size} event(s).`);
}

function totalHandlers(client) {
  let n = 0;
  for (const set of client.events.values()) n += set.size;
  return n;
}

async function scan(folder, client) {
  const entries = await readdir(folder, { withFileTypes: true });

  // Recurse directories first (serial is fine; file imports are where we need concurrency)
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scan(new URL(entry.name, folder), client);
    }
  }

  // Collect file import tasks and run them with concurrency
  const tasks = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;

    const ext = extname(entry.name).toLowerCase();
    if (!EXTS.has(ext)) continue;

    const full = new URL(entry.name, folder);

    tasks.push(importLimit(async () => {
      try {
        const mod = await import(full.href);
        const raw = mod.default ?? mod;

        const name = (mod.name ?? mod.default?.name) ?? raw?.name;
        const execute = (mod.execute ?? mod.default?.execute) ?? raw?.execute;
        const once = (mod.once ?? mod.default?.once ?? raw?.once) ?? false;

        if (typeof name !== 'string' || !name) {
          throw new Error('Missing/invalid "name"');
        }
        if (typeof execute !== 'function') {
          throw new Error('Missing/invalid "execute" function');
        }

        // Initialize set for this event
        if (!client.events.has(name)) client.events.set(name, new Set());

        // For once-events: prevent duplicate once-listeners for the same event file
        if (once) {
          // If any once-handler already exists, warn and skip
          // (Alternatively, allow multiple; but most of the time once-listeners should be unique)
          const hasOnce = [...client.listeners(name)].some(l => l.__voidOnce === true);
          if (hasOnce) {
            throw new Error(`Duplicate once-event "${name}"`);
          }
        }

        // Bind a safe wrapper so exceptions don’t explode silently
        const wrapper = async (...args) => {
          try {
            await execute(...args, client);
          } catch (err) {
            console.error(`[ERROR] Event "${name}" handler failed (${full.pathname}):`);
            console.error(err?.stack || err);
          }
        };
        // mark wrapper for duplicate-once detection
        wrapper.__voidOnce = !!once;

        // Register with Discord.js
        client[once ? 'once' : 'on'](name, wrapper);

        // Track handler for potential hot-reload or cleanup
        client.events.get(name).add(wrapper);
      } catch (err) {
        console.error(`[ERROR] ${full.pathname}:`);
        console.error(err?.stack || err);
      }
    }));
  }

  await Promise.all(tasks);
}
