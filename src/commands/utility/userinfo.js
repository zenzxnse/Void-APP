import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { ensureInGuild, tryDM } from '../../utils/moderation/mod.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'userinfo' });

const fmtPerms = (permBitField) => {
  const list = permBitField?.toArray?.() ?? [];
  // bubble up notable perms first
  const priority = ['Administrator', 'ManageGuild', 'ManageChannels', 'ManageRoles', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages'];
  const sorted = [...list].sort((a, b) => (priority.indexOf(a) + 999) - (priority.indexOf(b) + 999));
  return sorted.slice(0, 12).join(', ') + (list.length > 12 ? `, +${list.length - 12} more` : '') || 'None';
};

export default {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show information about a user.')
    .addUserOption(o => o.setName('user').setDescription('User to inspect (default: you)'))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Reply only visible to you (default: true)'))
    .addBooleanOption(o => o.setName('dm').setDescription('Send the stats to your DMs instead')),
  async execute(interaction) {
    ensureInGuild(interaction);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    const target = interaction.options.getUser('user') ?? interaction.user;

    // Ensure fresh user + flags
    let user = target;
    try { user = await interaction.client.users.fetch(target.id, { force: true }); } catch {}

    // Member (may not exist)
    let member = null;
    try { member = await interaction.guild.members.fetch({ user: user.id, force: true }); } catch {}

    // Flags / badges
    let flagsText = 'None';
    try {
      const flags = await user.fetchFlags();
      const arr = flags?.toArray?.() ?? [];
      flagsText = arr.length ? arr.map(x => `\`${x}\``).join(' • ') : 'None';
    } catch { /* ignore */ }

    const created = Math.floor(user.createdTimestamp / 1000);
    const joined = member?.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
    const boosted = member?.premiumSinceTimestamp ? Math.floor(member.premiumSinceTimestamp / 1000) : null;

    // Roles (without @everyone), sorted by position
    let rolesLine = 'None';
    if (member) {
      const roles = member.roles.cache
        .filter(r => r.id !== interaction.guild.roles.everyone.id)
        .sort((a, b) => b.position - a.position)
        .map(r => r.toString());
      if (roles.length) {
        const shown = roles.slice(0, 12).join(' ');
        rolesLine = roles.length > 12 ? `${shown} (+${roles.length - 12} more)` : shown;
      }
    }

    // Timeout / moderation
    let timeoutLine = 'No';
    const until = member?.communicationDisabledUntilTimestamp;
    if (until && until > Date.now()) {
      timeoutLine = `Yes — ends <t:${Math.floor(until / 1000)}:R>`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`User Info — ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .setColor(0x2ecc71)
      .addFields(
        {
          name: 'Account',
          value: [
            `**ID:** \`${user.id}\``,
            `**Created:** <t:${created}:F> (<t:${created}:R>)`,
            `**Bot:** ${user.bot ? 'Yes' : 'No'}`,
            `**Badges:** ${flagsText}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Guild',
          value: member ? [
            `**Nickname:** ${member.nickname ? `\`${member.nickname}\`` : 'None'}`,
            `**Joined:** ${joined ? `<t:${joined}:F> (<t:${joined}:R>)` : 'Unknown'}`,
            `**Boosting:** ${boosted ? `<t:${boosted}:R>` : 'No'}`,
            `**Timed Out:** ${timeoutLine}`,
          ].join('\n') : 'Not a member of this server.',
          inline: true,
        },
        {
          name: 'Roles',
          value: rolesLine,
          inline: false,
        },
        ...(member ? [{
          name: 'Notable Permissions',
          value: fmtPerms(member.permissions),
          inline: false,
        }] : []),
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    return tryDM(interaction, embed, ephemeral);
  },
};
