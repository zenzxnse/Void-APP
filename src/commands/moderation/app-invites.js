// src/commands/moderation/app-invites.js
import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { emojies } from '../../graphics/colors.js';

const MEMBER_PREVIEW_LIMIT = 15;
const PAGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const hasAppInvitePerms = (perms) =>
  perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild);

const hasManageChannels = (perms) => perms.has(PermissionFlagsBits.ManageChannels);
const hasManageWebhooks = (perms) => perms.has(PermissionFlagsBits.ManageWebhooks);

function roleMemberPreview(role) {
  const members = role.members; // requires GUILD_MEMBERS for full fidelity
  const total = members.size;
  const sample = [...members.values()]
    .sort((a, b) => a.user.username.localeCompare(b.user.username))
    .slice(0, MEMBER_PREVIEW_LIMIT)
    .map(m => `<@${m.id}>`)
    .join(', ');
  const suffix = total > MEMBER_PREVIEW_LIMIT ? ` …and **${total - MEMBER_PREVIEW_LIMIT}** more` : '';
  return total ? `${sample}${suffix}` : '*no members*';
}

function chunkLines(lines, perPage = 12) {
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) {
    pages.push(lines.slice(i, i + perPage));
  }
  return pages;
}

function buildSection(title, collection) {
  if (!collection.size) return [`${emojies.voidEye} **${title}**`, '*No roles found.*', ''];
  const header = `${emojies.voidEye} **${title}**`;
  const lines = [...collection.values()].map(r =>
    `• <@&${r.id}> \`${r.id}\`\n  > **Members (${r.members.size}):** ${roleMemberPreview(r)}`
  );
  return [header, ...lines, ''];
}

function buildAllPages({ appInviteRoles, manageChannelsRoles, manageWebhooksRoles, userBlock }) {
  const allLines = [
    `${emojies.modAction} **Permission audit: App Invites & Channel/Webhook Management**`,
    `> **Criteria:**`,
    `> • *App Invites*: **Administrator** or **Manage Server**`,
    `> • *Manager Channels Roles*: **Manage Channels**`,
    `> • *Webhook Managers*: **Manage Webhooks**`,
    '',
    ...buildSection('Roles that can invite/install apps', appInviteRoles),
    ...buildSection('Roles with Manage Channels', manageChannelsRoles),
    ...buildSection('Roles with Manage Webhooks', manageWebhooksRoles),
    ...(userBlock ? [userBlock, ''] : []),
    `*Showing up to ${MEMBER_PREVIEW_LIMIT} members per role. Results depend on the member cache; enable GUILD_MEMBERS intent for full coverage.*`
  ];

  // break into compact “visual” pages
  const paras = [];
  let acc = [];
  for (const line of allLines) {
    acc.push(line);
    // heuristic: start a new page after a blank line if current page is getting long
    if (!line.trim() && acc.join('\n').length > 1400) {
      paras.push(acc.join('\n'));
      acc = [];
    }
  }
  if (acc.length) paras.push(acc.join('\n'));

  // also protect against Discord 2000 char limit by further chunking
  const hardPages = [];
  for (const p of paras) {
    if (p.length <= 1900) { hardPages.push(p); continue; }
    const lines = p.split('\n');
    for (const chunk of chunkLines(lines, 20)) {
      hardPages.push(chunk.join('\n'));
    }
  }
  return hardPages.length ? hardPages : [allLines.join('\n')];
}

function buildPagerRow(currentPage, totalPages, interaction, makeId) {
  if (totalPages <= 1) return [];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', interaction, { page: 0 }, 900))
      .setLabel('⏮️ First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', interaction, { page: currentPage - 1 }, 900))
      .setLabel('◀️ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId('page_indicator')
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', interaction, { page: currentPage + 1 }, 900))
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages - 1),
    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', interaction, { page: totalPages - 1 }, 900))
      .setLabel('Last ⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1),
  );
  return [row];
}

export default {
  data: new SlashCommandBuilder()
    .setName('appinvites')
    .setDescription('Show roles that can invite/install apps, manage channels, or manage webhooks (with member previews).')
    .addUserOption(o =>
      o.setName('user').setDescription('Optionally check a specific member').setRequired(false))
    .addBooleanOption(o =>
      o.setName('ephemeral').setDescription('Respond privately').setRequired(false))
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);

    const eph = interaction.options.getBoolean('ephemeral') ?? false;
    const ephFlag = eph ? MessageFlags.Ephemeral : 0;
    await interaction.deferReply({ flags: ephFlag });

    // Guard: component router presence
    const router = interaction.client.components;
    if (!router || typeof router.makeId !== 'function') {
      return safeReply(interaction, {
        content: '❌ Components not initialized. Ask an admin to enable the Component Router.',
        flags: ephFlag,
      });
    }

    const makeId = router.makeId; // exported by ComponentRouter.js
    try {
      const roles = await interaction.guild.roles.fetch();

      const appInviteRoles = roles
        .filter(r => hasAppInvitePerms(r.permissions))
        .sort((a, b) => b.position - a.position);

      const manageChannelsRoles = roles
        .filter(r => hasManageChannels(r.permissions) && !hasAppInvitePerms(r.permissions))
        .sort((a, b) => b.position - a.position);

      const manageWebhooksRoles = roles
        .filter(r => hasManageWebhooks(r.permissions)
          && !hasAppInvitePerms(r.permissions)
          && !hasManageChannels(r.permissions))
        .sort((a, b) => b.position - a.position);

      // Optional per-user check
      const user = interaction.options.getUser('user', false);
      let userBlock = '';
      if (user) {
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          userBlock = `\n${emojies.voidEye} **User check:** Not in this server.`;
        } else {
          const perms = member.permissions;
          const canInvite = hasAppInvitePerms(perms);
          const hasMC = hasManageChannels(perms);
          const hasMW = hasManageWebhooks(perms);

          const grantRolesInvite = member.roles.cache
            .filter(r => hasAppInvitePerms(r.permissions))
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`).join(', ') || '*none*';

          const grantRolesMC = member.roles.cache
            .filter(r => hasManageChannels(r.permissions))
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`).join(', ') || '*none*';

          const grantRolesMW = member.roles.cache
            .filter(r => hasManageWebhooks(r.permissions))
            .sort((a, b) => b.position - a.position)
            .map(r => `<@&${r.id}>`).join(', ') || '*none*';

          userBlock =
            `\n${emojies.modAction} **User check for ${member.user.tag}:**` +
            `\n> **Invite/Install apps (Admin/Manage Server):** ${canInvite ? '✅' : '❌'} \n> Roles: ${grantRolesInvite}` +
            `\n> **Manage Channels:** ${hasMC ? '✅' : '❌'} \n> Roles: ${grantRolesMC}` +
            `\n> **Manage Webhooks:** ${hasMW ? '✅' : '❌'} \n> Roles: ${grantRolesMW}`;
        }
      }

      // Build content pages and persist for router handler to use
      const pages = buildAllPages({ appInviteRoles, manageChannelsRoles, manageWebhooksRoles, userBlock });
      const pageKey = `${interaction.guildId}-${interaction.user.id}`;
      if (!interaction.client.appinvitePages) interaction.client.appinvitePages = new Map();
      interaction.client.appinvitePages.set(pageKey, {
        pages,
        expires: Date.now() + PAGE_TTL_MS,
      });

      const components = buildPagerRow(0, pages.length, interaction, makeId);
      return safeReply(interaction, { content: pages[0], components, flags: ephFlag });
    } catch (err) {
      console.error('appinvites command error:', err);
      return safeReply(interaction, {
        content: `${emojies.error} Failed to audit roles. Try again later.`,
        flags: ephFlag,
      });
    }
  },
};
