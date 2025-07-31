import { Collection } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import pLimit from 'p-limit';
import config from './config.js';

const EXTS = new Set(['.js', '.mjs', '.cjs']);
const limit = pLimit(10);

export default async function loadCommands(
  client,
  dir = new URL(`../${config.COMMANDS_FOLDER}/`, import.meta.url),
) {
  client.commands = new Collection();
  await scan(dir, client);
  console.log(`[INFO] LOADED DEFINITIONS FOR: ${client.commands.size} COMMANDS`);
}

async function scan(folder, client) {
  const entries = await readdir(folder, { withFileTypes: true });
  const tasks = [];

  for (const entry of entries) {
    const full = new URL(entry.name, folder);

    if (entry.isDirectory()) {
      // Recurse and await the subdir’s tasks
      await scan(full, client);
      continue;
    }

    const ext = extname(entry.name).toLowerCase();
    if (!EXTS.has(ext)) continue;

    tasks.push(limit(async () => {
      try {
        const mod = await import(full.href);
        const cmd = mod.default ?? mod;

        if (!cmd || typeof cmd !== 'object') {
          throw new Error('Module did not export an object');
        }
        if (!cmd.data) throw new Error('Missing export "data"');
        if (!cmd.execute || typeof cmd.execute !== 'function') {
          throw new Error('Missing export "execute" (function)');
        }
        if (!cmd.data.name || typeof cmd.data.name !== 'string') {
          throw new Error('Invalid "data.name"');
        }

        if (client.commands.has(cmd.data.name)) {
          throw new Error(`Duplicate command "${cmd.data.name}"`);
        }
        
        client.commands.set(cmd.data.name, cmd);
      } catch (err) {
        console.error(`[ERROR] ${full.pathname}:`);
        console.error(err?.stack || err);
      }
    }));
  }

  // Run this directory’s file tasks with concurrency
  await Promise.all(tasks);
}