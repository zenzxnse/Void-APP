// God's Code
// button loader + dispatcher (Discord.js v14)
// - Supports exact customId, Aho–Corasick keywords (prefix/contains), and custom match() functions
// - Single 'interactionCreate' listener owned here (avoid double-ack across modules)
// - Uses Pino (createLogger/forInteraction) and integrates with middleware/telemetry
import * as ACMod from 'aho-corasick';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import config from '../src/core/config.js';
import { createLogger, forInteraction } from '../src/core/logger.js';
import { runMiddleware } from '../src/core/handlers/middleware.js';
import { MessageFlags } from 'discord.js';
/**
 * @typedef {object} ButtonHandler
 * @property {(interaction: import('discord.js').ButtonInteraction, client: import('discord.js').Client, context: object) => Promise<void>} execute - The function to run when the button is pressed.
 * @property {string} [label] - An explicit label for telemetry and cooldowns, overriding inferred names.
 * @property {string} [customId] - An exact custom ID to match.
 * @property {string[]} [customIds] - An array of exact custom IDs to match.
 * @property {string} [keyword] - A case-insensitive keyword for Aho-Corasick matching.
 * @property {string[]} [keywords] - An array of case-insensitive keywords.
 * @property {(id: string, interaction: import('discord.js').ButtonInteraction, client: import('discord.js').Client) => boolean|object|Promise<boolean|object>} [match] - A custom function to determine a match.
 * @property {'update'|'reply'|boolean} [defer] - Defer behavior. 'reply' or `true` will defer the reply ephemerally by default.
 * @property {boolean} [ephemeral] - Whether a deferred reply should be ephemeral. Defaults to true.
 * @property {number} [cooldownMs] - Per-user cooldown in milliseconds.
 * @property {import('discord.js').PermissionResolvable[]} [requiredPerms] - Permissions the user must have.
 * @property {import('discord.js').PermissionResolvable[]} [requiredBotPerms] - Permissions the bot must have.
 * @property {boolean} [guildOnly] - If true, the button can only be used in guilds.
 * @property {boolean} [dmPermission] - If false, the button cannot be used in DMs.
 * @property {boolean} [ownerOnly] - If true, only the bot owner can use this button.
 * @property {boolean} [ownerBypass] - If true, owner bypasses middleware checks (default true in middleware).
 * @property {boolean} [available_to_caller_only] - If true, restricts button interaction to the original command caller.
 * @property {Array<string>} [allowedUsers] - Allowed user IDs (Snowflake[] as strings).
 */
const log = createLogger({ mod: 'buttonHandler' });
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const importLimit = pLimit(Number.parseInt(config.BUTTON_IMPORT_CONCURRENCY, 10) || 10);
const HANDLER_FLAG = Symbol.for('void:buttons:listenerInstalled');
const AhoCtor = ACMod.default || ACMod.AhoCorasick || ACMod;
function toPath(u) {
  try { return fileURLToPath(u); } catch { return String(u); }
}
function inferNameFromFile(filePath) {
  const base = filePath.split(/[\\/]/).pop() || 'button';
  return base.replace(/\.[mc]?js$/i, '');
}
function flagsFromEphemeral(ephemeral) {
  return ephemeral ? { flags: MessageFlags.Ephemeral } : {};
}
/**
 * Helper to normalize search results from different Aho-Corasick library APIs
 * into a consistent [{ index, end, keyword }] format, sorted leftmost-longest.
 * @param {any[]} result - The raw search result from the AC library.
 * @returns {{index: number, end: number, keyword: string}[]}
 */
function normalizeACSearch(result) {
  const out = [];
  if (!result) return out;
  for (const item of result) {
    if (Array.isArray(item) && Array.isArray(item[1])) { // Shape: [endIndex, outputs[]]
      const end = item[0];
      for (const kw of item[1]) out.push({ end, index: end - kw.length + 1, keyword: kw });
    } else if (item && typeof item === 'object') { // Shape: { end, outputs }
      const end = item.end ?? item.index ?? 0;
      const outputs = item.outputs || item.words || item.keywords || item.matches || [];
      for (const kw of outputs) out.push({ end, index: end - kw.length + 1, keyword: kw });
    }
  }
  // Sort by start index (leftmost), then by keyword length (longest)
  out.sort((a, b) => a.index - b.index || b.keyword.length - a.keyword.length);
  return out;
}

function normalizeAllowedUsers(v) {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map(x => String(x).trim())
    // basic Snowflake sanity check (17–20 digits)
    .filter(id => /^\d{17,20}$/.test(id));
}

/**
 * Public API: load + wire dispatcher once.
 * @param {import('discord.js').Client} client
 * @param {URL} [dir]
 * @returns {Promise<boolean>}
 */
export default async function loadButtons(
  client,
  dir = new URL(`../../components/${config.BUTTONS_FOLDER || 'buttons'}/`, import.meta.url),
) {
  const store = { exact: new Map(), ac: { automaton: null, routes: new Map() }, matchers: [] };
  Object.freeze(store);
  client.buttonHandlers = store;
  client.buttons = store;
  let loaded = false;
  if (!client[HANDLER_FLAG]) {
    client.on('interactionCreate', onInteractionCreate(client, () => loaded));
    client[HANDLER_FLAG] = true;
  } else {
    log.warn('Button dispatcher already installed; skipping re-install');
  }
  const ok = await scan(dir, client);
  // Build AC regardless (no-op if none)
  buildAhoCorasick(client.buttonHandlers.ac);
  // IMPORTANT: mark loaded so the listener doesn’t keep saying “starting up”
  loaded = true;
  // Handle case where no handlers were loaded
  if (!ok) {
    if (String(config.FAIL_ON_EMPTY_BUTTONS).toLowerCase() === 'true' || config.FAIL_ON_EMPTY_BUTTONS === true) {
      log.error({ dir: toPath(dir) }, 'No button handlers found; failing startup as per environment config');
      return false;
    }
    log.warn({ dir: toPath(dir) }, 'No button handlers found; continuing with 0 handlers');
  }
  const total = store.exact.size + store.ac.routes.size + store.matchers.length;
  log.info({ total, exact: store.exact.size, ac: store.ac.routes.size, matchers: store.matchers.length }, 'Button registry ready');
  if (client.stats?.loaded) client.stats.loaded.buttons = total;
  if (client.stats) client.stats.buttonExecs ??= new Map();
  await checkOverlaps(store);
  return true;
}
async function scan(folder, client) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(err => {
    log.error({ err, dir: toPath(folder) }, 'Failed to read directory');
    return [];
  });
  if (!entries.length) return false;
  let loadedAny = false;
  const tasks = [];
  for (const entry of entries) {
    const full = new URL(entry.name, folder);
    if (entry.isDirectory()) {
      loadedAny = (await scan(full, client)) || loadedAny;
      continue;
    }
    if (!EXTS.has(extname(entry.name).toLowerCase())) continue;
    tasks.push(importLimit(async () => {
      const filePath = toPath(full);
      try {
        const mod = await import(full.href);
        const raw = mod.default ?? mod;
        const customId = raw.customId;
        const customIds = raw.customIds;
        const keyword = raw.keyword;
        const keywords = raw.keywords;
        const match = raw.match;
        const declaresKey = (typeof customId === 'string' && customId.length) || (Array.isArray(customIds) && customIds.length) || (typeof keyword === 'string' && keyword.length) || (Array.isArray(keywords) && keywords.length) || (typeof match === 'function');
        if (!declaresKey) return;
        const execute = raw.execute;
        if (typeof execute !== 'function') {
          throw new Error('Missing/invalid "execute" function');
        }
        const defer = raw.defer;
        const ephemeral = raw.ephemeral ?? true;
        if (defer !== undefined && !['update', 'reply', true, false].includes(defer)) {
          throw new Error(`Invalid defer value: "${defer}"`);
        }
        if ((defer === 'reply' || defer === true) && raw.ephemeral !== undefined && typeof raw.ephemeral !== 'boolean') {
          throw new Error('ephemeral must be boolean (or omitted) when using reply defer');
        }
        /** @type {ButtonHandler} */
        const record = {
          execute,
          defer,
          ephemeral,
          file: filePath,
          data: {
            name: raw.label || customId || (Array.isArray(customIds) && customIds[0]) || keyword || (Array.isArray(keywords) && keywords[0]) || match?.name || inferNameFromFile(filePath),
          },
          cooldownMs: raw.cooldownMs,
          requiredPerms: raw.requiredPerms,
          requiredBotPerms: raw.requiredBotPerms,
          guildOnly: raw.guildOnly,
          dmPermission: raw.dmPermission,
          ownerOnly: raw.ownerOnly,
          ownerBypass: raw.ownerBypass,
          available_to_caller_only: (raw.available_to_caller_only ?? raw.availableToCallerOnly) ?? false,
          allowedUsers: normalizeAllowedUsers(raw.allowedUsers),
        };
        const store = client.buttonHandlers;
        if (typeof customId === 'string' && customId.length) {
          ensureUnique(store.exact, customId, filePath);
          store.exact.set(customId, record);
          loadedAny = true;
        }
        if (Array.isArray(customIds)) {
          for (const id of customIds) {
            if (typeof id === 'string' && id.length) {
              ensureUnique(store.exact, id, filePath);
              store.exact.set(id, record);
              loadedAny = true;
            }
          }
        }
        if (typeof keyword === 'string' && keyword.length) {
          const key = keyword.toLowerCase();
          ensureUniqueAC(store.ac.routes, key, filePath);
          store.ac.routes.set(key, record);
          loadedAny = true;
        }
        if (Array.isArray(keywords)) {
          for (const kw of keywords) {
            if (typeof kw === 'string' && kw.length) {
              const key = kw.toLowerCase();
              ensureUniqueAC(store.ac.routes, key, filePath);
              store.ac.routes.set(key, record);
              loadedAny = true;
            }
          }
        }
        if (typeof match === 'function') {
          store.matchers.push({ match, handler: record });
          loadedAny = true;
        }
      } catch (err) {
        log.error({ file: filePath, err }, 'Failed to load button handler');
      }
    }));
  }
  await Promise.all(tasks);
  return loadedAny;
}
function ensureUnique(map, key, filePath) {
  if (map.has(key)) {
    throw new Error(`Duplicate button customId "${key}" in ${filePath} (already in ${map.get(key)?.file ?? 'unknown'})`);
  }
}
function ensureUniqueAC(routes, key, filePath) {
  if (routes.has(key)) {
    throw new Error(`Duplicate button keyword "${key}" in ${filePath} (already in ${routes.get(key)?.file ?? 'unknown'})`);
  }
}
function buildAhoCorasick(acStore) {
  if (!acStore.routes.size) return;
  acStore.automaton = new AhoCtor([...acStore.routes.keys()]);
}
async function checkOverlaps(store) {
  if (String(config.NODE_ENV || 'development').toLowerCase() === 'production') return;
  const probes = [...store.exact.keys()];
  if (!probes.length) return;
  for (const probe of probes) {
    const overlappingHandlers = new Set();
    let sourceText = [];
    if (store.ac.automaton) {
      const matches = normalizeACSearch(store.ac.automaton.search(probe.toLowerCase()));
      for (const m of matches) {
        const handler = store.ac.routes.get(m.keyword);
        if (handler) {
          overlappingHandlers.add(handler.file);
          sourceText.push(`keyword "${m.keyword}"`);
        }
      }
    }
    for (const { match, handler } of store.matchers) {
      try {
        const res = match(probe);
        const isHit = res instanceof Promise ? await Promise.race([res, new Promise(r => setTimeout(() => r('__timeout__'), 100))]) : res;
        if (isHit === '__timeout__') {
          log.warn({ probe, file: handler.file }, 'Matcher overlap probe timed out (>100ms)');
        } else if (isHit) {
          overlappingHandlers.add(handler.file);
          sourceText.push(`matcher ${match.name || 'anonymous'} (${handler.file})`);
        }
      } catch { }
    }
    if (overlappingHandlers.size > 1) {
      log.warn({ probe, sources: [...overlappingHandlers] }, 'Potential overlap: multiple distinct handlers match the same probe ID');
    }
  }
}
function onInteractionCreate(client, isLoaded) {
  return async (interaction) => {
    if (!interaction.isButton()) return;
    const ilog = forInteraction(interaction);
    if (!isLoaded()) {
      ilog.warn('Button interaction ignored during load');
      await safeReply(interaction, { content: 'Bot is starting up, please try again shortly.', flags: MessageFlags.Ephemeral });
      return;
    }
    const { exact, ac, matchers } = client.buttonHandlers;
    const id = interaction.customId;
    const exactHandler = exact.get(id);
    if (exactHandler) {
      await runButtonHandler(exactHandler, interaction, client, { kind: 'exact', id }, ilog);
      return;
    }
    if (ac.automaton) {
      const matches = normalizeACSearch(ac.automaton.search(id.toLowerCase()));
      if (matches.length) {
        const { index, keyword } = matches[0];
        const handler = ac.routes.get(keyword);
        await runButtonHandler(handler, interaction, client, { kind: 'ac', id, match: keyword, index }, ilog);
        return;
      }
    }
    for (const { match, handler } of matchers) {
      try {
        const res = await match(id, interaction, client);
        if (res) {
          const ctx = { kind: 'match', id, params: (res && typeof res === 'object') ? res : undefined };
          await runButtonHandler(handler, interaction, client, ctx, ilog);
          return;
        }
      } catch (err) {
        ilog.error({ err, file: handler.file || 'unknown' }, 'button match() threw');
      }
    }
    if (client.stats?.denies) client.stats.denies.unknownButton = (client.stats.denies.unknownButton || 0) + 1;
    ilog.warn('Unknown button interaction');
    const payload = { content: 'That button is no longer active.', flags: MessageFlags.Ephemeral };
    const replied = await safeReply(interaction, payload);
    if (!replied && (config.BUTTON_DM_FALLBACK === true || String(config.BUTTON_DM_FALLBACK).toLowerCase() === 'true') && interaction.user) {
      try {
        await interaction.user.send(payload.content);
      } catch (dmErr) {
        ilog.warn({ dmErr }, "DM fallback failed");
      }
    }
  };
}
async function runButtonHandler(handler, interaction, client, ctx, ilog) {
  const handlerWithName = { ...handler, data: { name: ctx.match || ctx.id || handler.data.name || 'button' } };
  if (shouldRunMiddleware(handlerWithName)) {
    const gate = await runMiddleware(interaction, handlerWithName);
    if (!gate.ok) return;
  }
  // Check if the button is restricted to the caller
  if (handler.available_to_caller_only) {
    const originalCallerId = interaction.message?.interaction?.user?.id;
    if (originalCallerId && originalCallerId !== interaction.user.id) {
      if (client.stats?.denies) client.stats.denies.callerOnly = (client.stats.denies.callerOnly || 0) + 1;
      await safeReply(interaction, { content: 'This button can only be used by the original command caller.', flags: MessageFlags.Ephemeral });
      return;
    }
  }
  // Check if the button is restricted to specific users
  if (handler.allowedUsers && !handler.allowedUsers.includes(interaction.user.id)) {
    if (client.stats?.denies) client.stats.denies.allowedUsers = (client.stats.denies.allowedUsers || 0) + 1;
    await safeReply(interaction, { content: 'You are not allowed to use this button.', flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    if (handler.defer === 'update') {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    } else if (handler.defer === 'reply' || handler.defer === true) {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply(flagsFromEphemeral(handler.ephemeral));
    }
  } catch (err) {
    ilog.warn({ err }, 'Button defer failed');
  }
  try {
    await handler.execute(interaction, client, ctx);
    if (client.stats?.buttonExecs) {
      const k = handlerWithName.data.name;
      client.stats.buttonExecs.set(k, (client.stats.buttonExecs.get(k) || 0) + 1);
    }
  } catch (err) {
    ilog.error({ err, file: handler.file || 'unknown' }, 'Button handler execution failed');
    await safeReply(interaction, { content: 'Something went wrong handling that button.', flags: MessageFlags.Ephemeral });
    if (client.stats) client.stats.errors = (client.stats.errors || 0) + 1;
  }
}
function shouldRunMiddleware(h) {
  return Boolean(h.cooldownMs || h.requiredPerms || h.requiredBotPerms || h.guildOnly || h.ownerOnly || h.dmPermission === false);
}
async function safeReply(interaction, payload) {
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(payload);
      return true;
    }
    if (interaction.deferred && !interaction.replied) {
      const { flags, ephemeral, ...edit } = payload || {};
      try { await interaction.editReply(edit); return true; } catch { /* fall through */ }
    }
    await interaction.followUp(payload);
    return true;
  } catch (err) {
    return false;
  }
}