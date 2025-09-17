import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, tx } from './index.js';

export async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const ran = new Set((await query('SELECT name FROM _migrations')).map(r => r.name));
  const dir = new URL('./migrations/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (ran.has(file)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    await tx(async c => {
      await c.query(sql);
      await c.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
    });
    console.log(`[DB] migrated ${file}`);
  }
}
