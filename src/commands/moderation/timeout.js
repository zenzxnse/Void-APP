import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import {
  ensureInGuild, normalizeReason, untilTs, checkHierarchy,
  safeReply, emitModLog, humanizeError,
} from '../../utils/moderation/mod.js';
import { parseDurationSeconds } from '../../utils/moderation/duration.js';

export default {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Temporarily mute a member (a.k.a. Timeout).')
    .addUserOption(o => o.setName('user').setDescription('Member to timeout').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration (e.g., 10m, 2h, 3d). Max 28d').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  requiredBotPerms: [PermissionFlagsBits.ModerateMembers],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const user = interaction.options.getUser('user', true);
    const durationRaw = interaction.options.getString('duration', true);
    const seconds = parseDurationSeconds(durationRaw);
    if (!seconds) return safeReply(interaction, { content: 'Invalid duration. Examples: `10m`, `2h`, `7d` (max 28d).', flags: MessageFlags.Ephemeral });

    const ms = Math.min(seconds * 1000, 28 * 24 * 60 * 60 * 1000); 

    const reason = normalizeReason(interaction.options.getString('reason'));
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return safeReply(interaction, { content: 'That user is not in this server.', flags: MessageFlags.Ephemeral });

    const hier = checkHierarchy({
      guild: interaction.guild,
      me: interaction.guild.members.me,
      actor: interaction.member,
      target: member,
    });
    if (!hier.ok) return safeReply(interaction, { content: humanizeError(hier.why), flags: MessageFlags.Ephemeral });

    await member.timeout(ms, `[${interaction.user.tag}] ${reason || 'No reason provided'}`);

    await emitModLog(interaction, {
      action: 'timeout',
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      targetId: member.id,
      ms,
      until: Date.now() + ms,
      reason,
      ts: Date.now(),
    });

    return safeReply(interaction, {
      content: `✅ Timed out **${member.user.tag}** for **${durationRaw}** — lifts ${untilTs(ms)}.${reason ? ` Reason: ${reason}` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
