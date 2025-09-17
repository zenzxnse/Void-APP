// src/commands/utility/stats.js
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  version as djsVersion,
} from 'discord.js';
import os from 'node:os';
import { safeReply } from '../../utils/moderation/mod.js';
import { getDbStats } from '../../core/db/index.js';
import { getJobStats } from '../../core/db/jobs.js';

const pad = (n) => String(n).padStart(2, '0');
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || parts.length) parts.push(`${h}h`);
  if (m || parts.length) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

const MB = 1024 * 1024;
const toMB = (b) => (b / MB).toFixed(1);

function formatMapEntries(map, limit = 10) {
  if (!map || map.size === 0) return '`—`';
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v], i) => `\`${pad(i + 1)}\` • **${k}** — ${v}`)
    .join('\n');
}

async function sampleEventLoopLag(ms = 150) {
  const start = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const end = performance.now();
  const lag = Math.max(0, end - start - ms);
  return Math.round(lag);
}

export default {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Detailed bot/system metrics for nerds.'),
  ownerOnly: true,
  dmPermission: false,

  async execute(interaction) {
    const { client } = interaction;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // ---- live measures
    const lagMs = await sampleEventLoopLag(150);

    // ---- process + system
    const uptime = formatUptime(process.uptime());
    const mem = process.memoryUsage();
    const cpu = os.cpus()?.[0];
    const load = os.loadavg(); // 1m/5m/15m

    // ---- discord/client
    const ping = Math.round(client.ws.ping);
    const guilds = client.guilds.cache.size;
    const shard = client.shard?.ids?.[0] ?? 0;

    // ---- your telemetry buckets (defensively optional)
    const s = client.stats ?? {};
    const loaded = s.loaded ?? {};
    const denies = s.denies ?? {};
    const commandExecs = s.commandExecs ?? new Map();

    // Component router (if present)
    const compStats = client.components?.getDetailedStats?.() ?? null;

    // ---- DB + jobs (best-effort)
    let db = null, jobs = null;
    try { db = await getDbStats(); } catch {}
    try { jobs = await getJobStats(); } catch {}

    // ---- build embed
    const topCommands = formatMapEntries(commandExecs, 8);
    const topComponents = compStats ? Object.entries(compStats.executions)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v], i) => `\`${pad(i + 1)}\` • **${k}** — ${v}`).join('\n') : '`—`';

    const denialInfo = [
      `Cooldown: \`${denies.cooldown ?? 0}\``,
      `User Perms: \`${denies.perms ?? 0}\``,
      `Owner Only: \`${denies.owner ?? 0}\``,
      `Guild Only: \`${denies.guildOnly ?? 0}\``,
      `DM Blocked: \`${denies.dmBlocked ?? 0}\``,
    ].join('\n');

    const handlerInfo = [
      `Commands: \`${loaded.commands ?? 0}\``,
      `Events: \`${loaded.events ?? 0}\``,
      `Buttons: \`${loaded.buttons ?? 0}\``,
      `Selects: \`${loaded.selects ?? 0}\``,
      `Modals: \`${loaded.modals ?? 0}\``,
    ].join('\n');

    const sysInfo = [
      `CPU: \`${cpu?.model?.split('@')[0].trim() || 'Unknown'}\``,
      `Cores: \`${os.cpus()?.length ?? '?'}\``,
      `Load: \`${load.map(n => n.toFixed(2)).join(' / ')}\``,
      `EL Lag: \`${lagMs}ms\``,
      `RAM RSS: \`${toMB(mem.rss)} MB\``,
      `Heap Used: \`${toMB(mem.heapUsed)} MB\` / \`${toMB(mem.heapTotal)} MB\``,
      `Ext+Buf: \`${toMB((mem.external ?? 0) + (mem.arrayBuffers ?? 0))} MB\``,
      `Node: \`${process.version}\``,
      `d.js: \`${djsVersion}\``,
      `Platform: \`${os.platform()} ${os.release()}\``,
    ].join('\n');

    const dbInfo = db ? [
      `Pool: ${db.poolInitialized ? '🟢' : '🔴'}`,
      `Conns: \`${db.totalConnections ?? 0}\` (idle: \`${db.idleConnections ?? 0}\`, wait: \`${db.waitingRequests ?? 0}\`)`,
      `Queries: \`${db.totalQueries ?? 0}\`, Slow: \`${db.slowQueries ?? 0}\`, Errors: \`${db.totalErrors ?? 0}\``,
    ].join('\n') : '`— (no pool)`';

    const jobInfo = jobs ? [
      `Pending: \`${jobs.pending ?? 0}\`  |  Proc: \`${jobs.processing ?? 0}\``,
      `Retrying: \`${jobs.retrying ?? 0}\`  |  Failed: \`${jobs.failed ?? 0}\``,
      `Total: \`${jobs.total ?? 0}\``,
      ...(typeof s.jobsProcessed === 'number' || typeof s.jobsFailed === 'number'
        ? [`Run: \`${s.jobsProcessed ?? 0}\` ok / \`${s.jobsFailed ?? 0}\` fail`]
        : []),
    ].join('\n') : '`— (n/a)`';

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Void — System & Bot Statistics')
      .setDescription(
        `**Uptime** \`${uptime}\` • **Ping** \`${ping}ms\` • **Guilds** \`${guilds}\` • **Shard** \`${shard}\``
      )
      .addFields(
        { name: 'System', value: sysInfo, inline: true },
        { name: 'Handlers Loaded', value: handlerInfo, inline: true },
        { name: 'Middleware Denials', value: denialInfo, inline: true },
        { name: 'Top Commands', value: topCommands, inline: true },
        { name: 'Components — Top Execs', value: topComponents, inline: true },
        ...(compStats ? [{
          name: 'Components — Router Stats',
          value: [
            `Handlers: \`${Object.entries(compStats.handlers).reduce((a, [,n]) => a + n, 0)}\``,
            `Denials: \`${Object.values(compStats.denials).reduce((a, n) => a + n, 0)}\``,
            `Errors: \`${compStats.errors ?? 0}\``,
          ].join('\n'),
          inline: true,
        }] : []),
        { name: 'Database', value: dbInfo, inline: true },
        { name: 'Job Queue', value: jobInfo, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: `Node ${process.version}` });

    return safeReply(interaction, { embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
