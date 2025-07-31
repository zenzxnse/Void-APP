import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Bot stats: uptime, counts, handlers'),
  ownerOnly: true,
  dmPermission: false,

  async execute(interaction) {
    const { client } = interaction;
    const s = client.stats ?? (client.stats = {});
    const uptimeSec = Math.floor(process.uptime());

    const loaded = s.loaded ?? {};
    const denies = s.denies ?? { cooldown: 0, perms: 0, owner: 0, guildOnly: 0, dmBlocked: 0 };
    const execs = s.commandExecs ?? new Map();

    const commandCounts =
      Array.from(execs.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => `• ${name}: ${count}`)
        .join('\n') || '—';

    const mem = process.memoryUsage();
    const embed = {
      title: 'Bot Stats',
      fields: [
        { name: 'Uptime', value: `${uptimeSec}s`, inline: true },
        { name: 'Ping', value: `${client.ws.ping} ms`, inline: true },
        { name: 'Guilds', value: `${client.guilds?.cache?.size ?? 0}`, inline: true },
        {
          name: 'Handlers Loaded',
          value:
            `cmds ${loaded.commands ?? 0} • events ${loaded.events ?? 0}\n` +
            `buttons ${loaded.buttons ?? 0} • selects ${loaded.selects ?? 0} • modals ${loaded.modals ?? 0}`,
        },
        {
          name: 'Denied (since start)',
          value:
            `cooldown ${denies.cooldown} • perms ${denies.perms}\n` +
            `owner ${denies.owner} • guildOnly ${denies.guildOnly} • dmBlocked ${denies.dmBlocked}`,
        },
        { name: 'Top Commands', value: commandCounts },
        {
          name: 'Memory',
          value: `rss ${(mem.rss / 1e6).toFixed(1)} MB • heap ${(mem.heapUsed / 1e6).toFixed(1)} MB`,
        },
      ],
      timestamp: new Date().toISOString(),
    };

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};