import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { URL } from 'node:url';
import config from './config.js'; 

const EXTS = new Set(['.js', '.mjs', '.cjs']);
const commands = [];
const names = new Set();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[FATAL] Missing environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

function getGuildIdsFromConfig() {
  const list = Array.isArray(config.GUILD_IDS) ? config.GUILD_IDS.filter(Boolean) : [];
  if (list.length) return list;
  if (typeof config.GUILD_ID === 'string' && config.GUILD_ID) return [config.GUILD_ID];
  return [];
}

async function scan(dir = new URL(`../${config.COMMANDS_FOLDER}/`, import.meta.url)) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);

    if (entry.isDirectory()) { await scan(full); continue; }
    if (!EXTS.has(extname(entry.name).toLowerCase())) continue;

    try {
      const mod = await import(full.href);
      const cmd = mod.default ?? mod;

      if (!cmd?.data || !cmd?.execute) { console.warn(`[WARN] ${full.pathname}: missing "data" or "execute". Skipped.`); continue; }
      if (typeof cmd.data.name !== 'string' || !cmd.data.name) { console.warn(`[WARN] ${full.pathname}: invalid "data.name". Skipped.`); continue; }
      if (typeof cmd.data.toJSON !== 'function') { console.warn(`[WARN] ${full.pathname}: "data" is not a SlashCommandBuilder. Skipped.`); continue; }
      if (names.has(cmd.data.name)) { console.warn(`[WARN] Duplicate command "${cmd.data.name}" ignored (${entry.name}).`); continue; }

      names.add(cmd.data.name);
      commands.push(cmd.data.toJSON());
    } catch (err) {
      console.error(`[ERROR] Failed to load ${full.pathname}:`);
      console.error(err?.stack || err);
    }
  }
}

(async () => {
  await scan();
  console.log(`[INFO] Collected ${commands.length} commands.`);

  const token = requireEnv('VOID_TOKEN');
  const APP_ID = requireEnv('APP_ID');
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    if (config.GLOBAL) {
      console.log('[INFO] Registering **global** application commands…');
      await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
      console.log('[INFO] ✔ Global commands registered. (Propagation may take a while.)');
    } else {
      const guildIds = getGuildIdsFromConfig();
      if (guildIds.length === 0) {
        console.error('[FATAL] No guild IDs found in config.GUILD_IDS or config.GUILD_ID (and GLOBAL=false).');
        process.exit(1);
      }

      console.log(`[INFO] Registering guild commands for ${guildIds.length} guild(s)…`);
      const results = await Promise.allSettled(
        guildIds.map(gid =>
          rest.put(Routes.applicationGuildCommands(APP_ID, gid), { body: commands })
        )
      );

      results.forEach((res, i) => {
        const gid = guildIds[i];
        if (res.status === 'fulfilled') console.log(`[INFO] ✔ Registered for guild ${gid}`);
        else console.error(`[ERROR] Failed for guild ${gid}:`, res.reason?.stack || res.reason);
      });

      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed) process.exitCode = 1;
    }
  } catch (err) {
    console.error('[ERROR] Failed to register commands:');
    console.error(err?.stack || err);
    process.exitCode = 1;
  }
})();
