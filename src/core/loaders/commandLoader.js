import { Collection } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import config from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger({ mod: 'commandLoader' });
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const limit = pLimit(parseInt(process.env.COMMAND_IMPORT_CONCURRENCY, 10) || 10);

function toPath(u) {
  try { return fileURLToPath(u); } catch { return String(u); }
}

/**
 * Recursively scans a directory for command files and loads them into the client.
 * @param {import('discord.js').Client} client - The Discord client instance.
 * @param {URL} dir - The directory to scan.
 * @returns {Promise<boolean>} True if at least one command was successfully loaded.
 */
async function scan(client, dir) {
    let loadedAny = false;
    let skippedCount = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(err => {
        log.error({ err, dir: toPath(dir) }, 'Failed to read command directory');
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
                const cmd = mod.default ?? mod;

                if (typeof cmd !== 'object' || !cmd) throw new Error('Module did not export a command object.');
                if (typeof cmd.execute !== 'function') throw new Error('Missing or invalid "execute" function.');
                if (typeof cmd.data?.name !== 'string' || !cmd.data.name) throw new Error('Missing or invalid "data.name" string.');

                if (typeof cmd.data.toJSON !== 'function') {
                    log.warn({ file: filePath }, 'Command "data" property is missing a toJSON method. It may not be a SlashCommandBuilder instance.');
                }

                if (client.commands.has(cmd.data.name)) {
                    log.warn({ file: filePath, name: cmd.data.name }, 'Duplicate command name; skipping');
                    skippedCount++;
                    return;
                }

                client.commands.set(cmd.data.name, cmd);
                loadedAny = true;
            } catch (err) {
                log.error({ file: filePath, err }, 'Failed to load command');
                skippedCount++;
            }
        }));
    }

    await Promise.all(tasks);
    if (skippedCount > 0) {
        log.warn({ skipped: skippedCount, dir: toPath(dir) }, 'Some command files were skipped');
    }
    return loadedAny;
}

/**
 * Loads all slash commands from the configured directory into the client.
 * @param {import('discord.js').Client} client The Discord client instance.
 * @param {URL} [dir] The base directory to load commands from.
 * @returns {Promise<boolean>} True if any command was loaded, false otherwise.
 */
export default async function loadCommands(
  client,
  dir = new URL(`../../${config.COMMANDS_FOLDER || 'commands'}/`, import.meta.url),
) {
  client.commands = new Collection();
  const success = await scan(client, dir);

  if (!success && process.env.NODE_ENV !== 'production') {
      log.warn({ dir: toPath(dir) }, 'No valid commands were loaded from this directory. Check file exports and directory path.');
  }

  log.info({ count: client.commands.size }, 'Command loading complete');
  if (client.stats?.loaded) {
    client.stats.loaded.commands = client.commands.size;
  }

  return success;
}