import { Collection } from "discord.js";
import { readdir } from "node:fs/promises";
import { extname } from "node:path";
import pLimit from "p-limit";
import config from "./config.js";// buttonHandler.js
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import pLimit from 'p-limit';
import config from './config.js';

const EXTS = new Set(['.js', '.mjs', '.cjs']);
const importLimit = pLimit(10);

export default async function loadButtons(
  client,
  dir = new URL(`../${config.BUTTONS_FOLDER}/`, import.meta.url),
) {
  // Structure:
  // client.buttons = {
  //   exact: Map<customId, handler>,
  //   patterns: Array<{ pattern:RegExp, execute, defer, ephemeral }>,
  //   matchers: Array<{ match:Function, execute, defer, ephemeral }>,
  // }
  client.buttons = { exact: new Map(), patterns: [], matchers: [] };

  await scan(dir, client);

  // Install dispatcher once
  if (!client.__buttonsDispatcherInstalled) {
    client.on('interactionCreate', onInteractionCreate(client));
    client.__buttonsDispatcherInstalled = true;
  }

  const total =
    client.buttons.exact.size +
    client.buttons.patterns.length +
    client.buttons.matchers.length;

  console.log(
    `[INFO] BUTTON REGISTRY: ${total} handlers ` +
    `(exact=${client.buttons.exact.size}, regex=${client.buttons.patterns.length}, matchers=${client.buttons.matchers.length})`,
  );
}

async function scan(folder, client) {
  const entries = await readdir(folder, { withFileTypes: true });

  // Recurse into directories first
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scan(new URL(entry.name, folder), client);
    }
  }

  // Import files with concurrency
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

        const execute =
          raw.execute ?? mod.execute ?? mod.default?.execute;
        const customId =
          raw.customId ?? mod.customId ?? mod.default?.customId;
        const pattern =
          raw.pattern ?? mod.pattern ?? mod.default?.pattern;
        const match =
          raw.match ?? mod.match ?? mod.default?.match;
        const defer =
          raw.defer ?? mod.defer ?? mod.default?.defer ?? 'update';
        const ephemeral =
          raw.ephemeral ?? mod.ephemeral ?? mod.default?.ephemeral;

        // Validate execute
        if (typeof execute !== 'function') {
          throw new Error('Missing/invalid "execute" function');
        }

        // Determine registration kind
        if (typeof customId === 'string' && customId.length) {
          if (client.buttons.exact.has(customId)) {
            throw new Error(`Duplicate button customId "${customId}"`);
          }
          client.buttons.exact.set(customId, { execute, defer, ephemeral, file: full.pathname });
          return;
        }

        if (pattern instanceof RegExp) {
          client.buttons.patterns.push({ pattern, execute, defer, ephemeral, file: full.pathname });
          return;
        }

        if (typeof match === 'function') {
          client.buttons.matchers.push({ match, execute, defer, ephemeral, file: full.pathname });
          return;
        }

        throw new Error('A button module must export one of: "customId" (string), "pattern" (RegExp), or "match" (function)');
      } catch (err) {
        console.error(`[ERROR] ${full.pathname}:`);
        console.error(err?.stack || err);
      }
    }));
  }

  await Promise.all(tasks);
}

function onInteractionCreate(client) {
  return async (interaction) => {
    if (!interaction.isButton()) return;

    const id = interaction.customId;
    const { exact, patterns, matchers } = client.buttons;

    // 1) Exact match
    const exactHandler = exact.get(id);
    if (exactHandler) {
      return runButtonHandler(exactHandler, interaction, client, { kind: 'exact' });
    }

    // 2) Regex patterns (first match wins)
    for (const h of patterns) {
      const m = h.pattern.exec(id);
      if (m) {
        // Extract named groups if present (Node supports named groups in JS RegExp)
        const params = m.groups ? { ...m.groups } : { 0: m[0], 1: m[1] };
        return runButtonHandler(h, interaction, client, { kind: 'pattern', params, match: m[0] });
      }
    }

    // 3) Custom matcher
    for (const h of matchers) {
      let res = false;
      try {
        res = await h.match(id, interaction, client);
      } catch (err) {
        console.error(`[ERROR] button match() threw (${h.file || 'unknown file'}):`);
        console.error(err?.stack || err);
      }
      if (res) {
        // If matcher returns an object, treat as params
        const params = (typeof res === 'object' && res !== null) ? res : undefined;
        return runButtonHandler(h, interaction, client, { kind: 'match', params });
      }
    }

    // No handler found
    // Optional: log unknown IDs in dev
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[WARN] No button handler for customId="${id}"`);
    }
  };
}

async function runButtonHandler(handler, interaction, client, ctx) {
  try {
    // Defer logic
    // 'update' => deferUpdate(); 'reply' or true => deferReply({ephemeral}); false => do nothing
    const defer = handler.defer;
    const ephemeral = typeof handler.ephemeral === 'boolean'
      ? handler.ephemeral
      : true; // safe default for reply defers

    if (defer === 'update') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }
    } else if (defer === 'reply' || defer === true) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral });
      }
    }

    await handler.execute(interaction, client, ctx);
  } catch (err) {
    console.error(`[ERROR] Button handler failed (${handler.file || 'unknown file'}) for id="${interaction.customId}":`);
    console.error(err?.stack || err);

    // Best-effort user feedback if we can still respond
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong handling that button.', ephemeral: true });
      } else if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: 'Something went wrong handling that button.' });
      }
    } catch (_) {}
  }
}
