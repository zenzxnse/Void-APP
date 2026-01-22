import {
  SlashCommandBuilder, MessageFlags, roleMention,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { emojies } from '../../graphics/colors.js';

const MAX_ROLES = 10;
const MAX_LIST = 150; // hard cap to avoid mega replies; adjust to taste

export default {
  data: new SlashCommandBuilder()
    .setName('members-with-roles')
    .setDescription('Find members who have any of the specified roles.')
    .addRoleOption(o => o.setName('role1').setDescription('Role').setRequired(true))
    .addRoleOption(o => o.setName('role2').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role3').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role4').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role5').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role6').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role7').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role8').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role9').setDescription('Role').setRequired(false))
    .addRoleOption(o => o.setName('role10').setDescription('Role').setRequired(false))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Respond privately'))
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);

    const eph = interaction.options.getBoolean('ephemeral') ?? false;
    const ephFlag = eph ? MessageFlags.Ephemeral : 0;
    await interaction.deferReply({ flags: ephFlag });

    try {
      // Gather provided roles (skip nulls, dedupe by id)
      const roles = [];
      for (let i = 1; i <= MAX_ROLES; i++) {
        const r = interaction.options.getRole(`role${i}`, false);
        if (r && !roles.find(x => x.id === r.id)) roles.push(r);
      }

      if (roles.length === 0) {
        return safeReply(interaction, {
          content: `${emojies.error} Provide at least one role.`,
          flags: ephFlag,
        });
      }

      // Build union of members across all roles
      // Note: role.members relies on member cache (requires GUILD_MEMBERS intent for full coverage)
      const union = new Map(); // userId -> GuildMember
      const perRoleCounts = [];

      for (const role of roles) {
        const membersCol = role.members; // Collection<string, GuildMember>
        perRoleCounts.push({ role, count: membersCol.size });
        for (const [id, gm] of membersCol) {
          union.set(id, gm);
        }
      }

      const unionArray = [...union.values()].sort((a, b) =>
        a.user.username.localeCompare(b.user.username));

      const total = unionArray.length;
      const truncated = total > MAX_LIST;
      const shown = truncated ? unionArray.slice(0, MAX_LIST) : unionArray;

      const memberLines = shown.length
        ? shown.map(m => `• <@${m.id}> (${m.user.tag})`).join('\n')
        : '*No members matched those roles.*';

      const roleSummary = roles.map(r => roleMention(r.id)).join(', ');
      const perRoleSummary = perRoleCounts
        .map(({ role, count }) => `${roleMention(role.id)}: **${count}**`)
        .join(' · ');

      const content = [
        `${emojies.modAction} **Members with any of the roles:** ${roleSummary}`,
        `> **Per-role counts:** ${perRoleSummary}`,
        `> **Total unique members:** **${total}**${truncated ? ` (showing first ${MAX_LIST})` : ''}`,
        '',
        memberLines,
        truncated ? `\n${emojies.voidEye} *List truncated. Refine roles or raise the cap in code if needed.*` : null,
      ].filter(Boolean).join('\n');

      return safeReply(interaction, { content, flags: ephFlag });
    } catch (err) {
      console.error('members-with-roles command error:', err);
      return safeReply(interaction, {
        content: `${emojies.error} Failed to list members. Try again later.`,
        flags: ephFlag,
      });
    }
  },
};
