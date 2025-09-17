import { query } from "./index.js";

export async function ensureGuildRow(guildId) {
  // Idempotent: safe under concurrency
  await query(
    `INSERT INTO guild_config (guild_id)
     VALUES ($1)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}