import {
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { createLogger } from '../../core/logger.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';

const log = createLogger({ mod: 'cmd:membercount' });

export default {
  data: new SlashCommandBuilder()
    .setName('membercount')
    .setDescription('Get detailed member statistics for the server')
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Send response privately (default: true)')),
  guildOnly: true,

  async execute(interaction) {
    await ensureInGuild(interaction);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    try {
      const guild = interaction.guild;
      const isLarge = guild.memberCount > 5000;

      let members = guild.members.cache;
      if (!isLarge && members.size < guild.memberCount) {
        try {
          members = await guild.members.fetch();
          log.debug({ guildId: guild.id, fetched: members.size }, 'Fetched all members for accurate count');
        } catch (err) {
          log.warn({ err }, 'Could not fetch all members, using cache');
        }
      }

      const stats = {
        total: guild.memberCount,
        cached: members.size,
        humans: 0,
        bots: 0,
        online: 0,
        idle: 0,
        dnd: 0,
        offline: 0,
        joinedToday: 0,
        joinedThisWeek: 0,
        boosters: guild.premiumSubscriptionCount || 0,
      };

      const now = Date.now();
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const startOfWeek = new Date(now - 7 * 24 * 60 * 60 * 1000);

      for (const m of members.values()) {
        if (m.user.bot) stats.bots++; else stats.humans++;
        const status = m.presence?.status || 'offline';
        if (status === 'online') stats.online++;
        else if (status === 'idle') stats.idle++;
        else if (status === 'dnd') stats.dnd++;
        else stats.offline++;

        if (m.joinedTimestamp) {
          if (m.joinedTimestamp >= startOfDay.getTime()) stats.joinedToday++;
          if (m.joinedTimestamp >= startOfWeek.getTime()) stats.joinedThisWeek++;
        }
      }

      // approximate humans/bots if cache incomplete
      if (stats.cached > 0 && stats.cached < stats.total) {
        const ratio = stats.total / stats.cached;
        const estHumans = Math.min(Math.round(stats.humans * ratio), stats.total);
        stats.humans = estHumans;
        stats.bots = Math.max(stats.total - stats.humans, 0);
      }

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${guild.name} Member Statistics`)
        .setColor(0x5865F2)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setTimestamp();

      if (isLarge || stats.cached < stats.total) {
        embed.setDescription(
          `⚠️ **Note:** Statistics are ${isLarge ? 'approximate for large servers' : 'based on cached data'}\n` +
          `Cached: ${stats.cached.toLocaleString()}/${stats.total.toLocaleString()} members`,
        );
      }

      embed.addFields(
        { name: '👥 Total Members', value: stats.total.toLocaleString(), inline: true },
        { name: '👤 Humans', value: `${stats.humans.toLocaleString()} (${pct(stats.humans, stats.total)}%)`, inline: true },
        { name: '🤖 Bots', value: `${stats.bots.toLocaleString()} (${pct(stats.bots, stats.total)}%)`, inline: true },
      );

      if (stats.boosters > 0) {
        embed.addFields({ name: '💎 Server Boosts', value: `${stats.boosters} boosts (Level ${guild.premiumTier})`, inline: true });
      }

      embed.addFields(
        { name: '📅 Joined Today', value: stats.joinedToday.toLocaleString(), inline: true },
        { name: '📊 Joined This Week', value: stats.joinedThisWeek.toLocaleString(), inline: true },
      );

      const presenceKnown = stats.online + stats.idle + stats.dnd > 0;
      if (presenceKnown) {
        const bar = presenceBar(stats);
        embed.addFields({
          name: '🟢 Presence Status',
          value:
            `\`\`\`\n${bar}\n\`\`\`\n` +
            `🟢 Online: ${stats.online.toLocaleString()}\n` +
            `🟡 Idle: ${stats.idle.toLocaleString()}\n` +
            `🔴 DND: ${stats.dnd.toLocaleString()}\n` +
            `⚫ Offline: ${Math.max(stats.total - (stats.online + stats.idle + stats.dnd)).toLocaleString()}`,
          inline: false,
        });
      } else {
        embed.addFields({ name: '⚠️ Presence Data', value: 'Presence data unavailable (requires Presence Intent)', inline: false });
      }

      const createdAt = guild.createdTimestamp;
      const ageDays = Math.floor((Date.now() - createdAt) / 86_400_000);
      embed.addFields({ name: '🎂 Server Age', value: `${ageDays.toLocaleString()} days\nCreated: <t:${Math.floor(createdAt / 1000)}:D>`, inline: false });

      await safeReply(interaction, { embeds: [embed], flags: ephemeral ? MessageFlags.Ephemeral : undefined });
      interaction.client.stats?.commandExecs?.set('membercount', (interaction.client.stats.commandExecs.get('membercount') || 0) + 1);
    } catch (err) {
      log.error({ err, guildId: interaction.guildId }, 'Failed to get member stats');
      await safeReply(interaction, { content: '❌ Failed to retrieve member statistics.', flags: ephemeral ? MessageFlags.Ephemeral : undefined, status: 'error' });
    }
  },
};

function pct(part, total) {
  return total > 0 ? ((part / total) * 100).toFixed(1) : '0.0';
}

function presenceBar(stats) {
  const total = Math.max(stats.total, stats.cached);
  const len = 20;
  const online = Math.round((stats.online / total) * len);
  const idle = Math.round((stats.idle / total) * len);
  const dnd = Math.round((stats.dnd / total) * len);
  const offline = Math.max(len - online - idle - dnd, 0);
  return '🟢'.repeat(online) + '🟡'.repeat(idle) + '🔴'.repeat(dnd) + '⚫'.repeat(offline);
}
