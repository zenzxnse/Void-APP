// src/loaders/eventLoader.js
// Production-grade loader for Discord.js events.
// Features:
// - Supports multiple handlers per event.
// - Safe-wraps all handlers to prevent crashes.
// - Guards against duplicate `once` listeners for the same event.
// - Consistent logging and telemetry integration.

import { Collection } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import config from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger({ mod: 'eventLoader' });
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const limit = pLimit(parseInt(process.env.EVENT_IMPORT_CONCURRENCY, 10) || 10);

function toPath(u) {
  try { return fileURLToPath(u); } catch { return String(u); }
}

/**
 * Recursively scans a directory for event files and registers their handlers.
 * @param {import('discord.js').Client} client - The Discord client instance.
 * @param {URL} dir - The directory to scan.
 * @returns {Promise<boolean>} True if at least one event handler was successfully loaded.
 */
async function scan(client, dir) {
    let loadedAny = false;
    let skippedCount = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(err => {
        log.error({ err, dir: toPath(dir) }, 'Failed to read event directory');
        return [];
    });

    if (!entries.length) return false;

    const tasks = [];
    for (const entry of entries) {
        const full = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) {
            loadedAny = (await scan(client, full)) || loadedAny;
            continue;
        }

        if (!EXTS.has(extname(entry.name).toLowerCase())) continue;

        tasks.push(limit(async () => {
            const filePath = toPath(full);
            try {
                const mod = await import(full.href);
                const event = mod.default ?? mod;

                const name = event.name;
                const execute = event.execute;
                const once = event.once ?? false;

                if (typeof name !== 'string' || !name) throw new Error('Missing or invalid "name" export.');
                if (typeof execute !== 'function') throw new Error('Missing or invalid "execute" function.');

                if (once) {
                    const hasOnce = client.listeners(name).some(l => l.__voidOnce === true);
                    if (hasOnce) {
                        log.warn({ event: name, file: filePath }, 'Duplicate "once" listener detected; skipping');
                        skippedCount++;
                        return;
                    }
                }

                const wrapper = async (...args) => {
                    try {
                        await execute(...args, client);
                    } catch (err) {
                        log.error({ err, event: name, file: filePath }, 'Event handler execution failed');
                    }
                };
                wrapper.__voidOnce = once;

                if (!client.events.has(name)) {
                    client.events.set(name, new Set());
                }
                client.events.get(name).add(wrapper);
                client[once ? 'once' : 'on'](name, wrapper);
                loadedAny = true;
            } catch (err) {
                log.error({ file: filePath, err }, 'Failed to load event handler');
                skippedCount++;
            }
        }));
    }

    await Promise.all(tasks);
    if (skippedCount > 0) {
        log.warn({ skipped: skippedCount, dir: toPath(dir) }, 'Some event files were skipped');
    }
    return loadedAny;
}

/**
 * Loads all event handlers from the configured directory and attaches them to the client.
 * @param {import('discord.js').Client} client The Discord client instance.
 * @param {URL} [dir] The base directory to load events from.
 * @returns {Promise<boolean>} True if any event handler was loaded, false otherwise.
 */
export default async function loadEvents(
  client,
  dir = new URL(`../../${config.EVENTS_FOLDER || 'events'}/`, import.meta.url),
) {
  client.events = new Collection();
  const success = await scan(client, dir);

  if (!success && process.env.NODE_ENV !== 'production') {
    log.warn({ dir: toPath(dir) }, 'No valid event handlers were loaded from this directory.');
  }

  let totalHandlers = 0;
  for (const handlerSet of client.events.values()) {
    totalHandlers += handlerSet.size;
  }

  log.info({ events: client.events.size, handlers: totalHandlers }, 'Event loading complete');
  if (client.stats?.loaded) {
    client.stats.loaded.events = totalHandlers;
  }

  return success;
}