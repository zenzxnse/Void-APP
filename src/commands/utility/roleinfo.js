import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  time,
} from 'discord.js';
import { ensureInGuild, tryDM } from '../../utils/moderation/mod.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'roleinfo' });

const hex = (c) => c?.toString(16).padStart(6, '0').toUpperCase();

export default {
  data: new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Show information about a role.')
    .addRoleOption(o => o.setName('role').setDescription('Role to inspect').setRequired(true))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Reply only visible to you (default: true)'))
    .addBooleanOption(o => o.setName('dm').setDescription('Send the stats to your DMs instead')),
  async execute(interaction) {
    ensureInGuild(interaction);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    const role = interaction.options.getRole('role', true);

    // Member count (safe approach: try cache; if likely incomplete and guild is small, fetch)
    let memberCount = role.members.size;
    if (memberCount === 0 && interaction.guild.memberCount <= 5000) {
      try {
        const all = await interaction.guild.members.fetch({ withPresences: false });
        memberCount = all.filter(m => m.roles.cache.has(role.id)).size;
      } catch {
        // leave as cache size if fetching fails or is too large
      }
    }

    const created = Math.floor(role.createdTimestamp / 1000);
    const perms = role.permissions.toArray();
    const permsShown = perms.slice(0, 14).join(', ') + (perms.length > 14 ? `, +${perms.length - 14} more` : '') || 'None';

    const embed = new EmbedBuilder()
      .setTitle(`Role Info — ${role.name}`)
      .setColor(role.color || 0x9aa0a6)
      .addFields(
        {
          name: 'Overview',
          value: [
            `**ID:** \`${role.id}\``,
            `**Created:** <t:${created}:F> (<t:${created}:R>)`,
            `**Color:** ${role.color ? `#${hex(role.color)}` : 'None'}`,
            `**Position:** ${role.position}`,
            `**Mentionable:** ${role.mentionable ? 'Yes' : 'No'}`,
            `**Hoisted:** ${role.hoist ? 'Yes' : 'No'}`,
            `**Managed:** ${role.managed ? 'Yes' : 'No'}`,
            `**Members with role:** ${memberCount.toLocaleString()}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Permissions',
          value: permsShown,
          inline: false,
        },
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    // Show role mention at the bottom (avoids ping by default allowedMentions)
    embed.addFields({ name: 'Mention', value: role.toString(), inline: false });

    return tryDM(interaction, embed, ephemeral);
  },
};
