// src/commands/moderation/warns.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { getActiveWarnCount, getUserWarns } from '../../utils/moderation/mod-db.js';
import { makeId } from '../../components/ComponentRouter.js';

// ---------- Pagination constants (edit these) ----------
const PAGE_SIZE = 10; // 10 warns per page

export const WARN_BUTTON_EMOJIS = {
  first: '⏮️',
  prev: '◀️',
  next: '▶️',
  last: '⏭️',
};
// -------------------------------------------------------

export default {
  data: new SlashCommandBuilder()
    .setName('warns')
    .setDescription('Show warnings for a member.')
    .addUserOption(o =>
      o
        .setName('user')
        .setDescription('Member')
        .setRequired(true),
    )
    .addBooleanOption(o =>
      o
        .setName('ephemeral')
        .setDescription("Bot's reply will be ephemeral (only visible to you)"),
    )
    .addIntegerOption(o =>
      o
        .setName('limit')
        .setDescription('Maximum warnings to fetch (default: 25, max: 50)')
        .setMinValue(1)
        .setMaxValue(50),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);

    const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
    const limitArg = interaction.options.getInteger('limit');
    const fetchLimit = Math.min(limitArg ?? 25, 50); // hard cap to keep payloads small

    // Defer reply respecting ephemeral flag (via flags, NOT ephemeral boolean)
    await interaction.deferReply(
      ephemeral ? { flags: MessageFlags.Ephemeral } : undefined,
    );

    const targetUser = interaction.options.getUser('user', true);

    try {
      const [count, list] = await Promise.all([
        getActiveWarnCount(interaction.guildId, targetUser.id),
        getUserWarns(interaction.guildId, targetUser.id, fetchLimit),
      ]);

      const totalFetched = list.length;
      const totalPages = Math.max(1, Math.ceil(totalFetched / PAGE_SIZE));
      const currentPage = 0; // start at first page

      const pageWarns = paginate(list, currentPage, PAGE_SIZE);
      const embed = buildWarnsPageEmbed({
        user: targetUser,
        guild: interaction.guild,
        warns: pageWarns,
        totalCount: count,
        totalFetched,
        page: currentPage,
        totalPages,
        pageSize: PAGE_SIZE,
      });

      const components =
        totalPages > 1
          ? [buildWarnsPaginationRow(interaction, targetUser.id, currentPage, totalPages, fetchLimit)]
          : [];

      return safeReply(interaction, {
        embeds: [embed],
        components,
        ...(ephemeral && { flags: MessageFlags.Ephemeral }),
      });
    } catch (err) {
      console.error('Warns command error:', err);
      return safeReply(interaction, {
        content:
          '❌ Failed to fetch warnings. Please try again or contact an administrator.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

// ---------- Helpers ----------

function paginate(list, page, pageSize) {
  const start = page * pageSize;
  return list.slice(start, start + pageSize);
}

/**
 * Build the page embed for warns.
 */
function buildWarnsPageEmbed({
  user,
  guild,
  warns,
  totalCount,
  totalFetched,
  page,
  totalPages,
  pageSize,
}) {
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Warnings for ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 128 }))
    .setColor(totalCount > 0 ? 0xffa500 : 0x00ff00) // Orange if has warns, green if clean
    .setTimestamp();

  if (warns.length === 0) {
    embed
      .setDescription('✅ No active warnings found.')
      .setFooter({ text: 'Clean record' });
  } else {
    const lines = warns.map((w, idx) => {
      const absoluteIndex = page * pageSize + idx + 1; // 1-based across pages
      const timestamp = Math.floor(new Date(w.created_at).getTime() / 1000);

      const parts = [
        `**${absoluteIndex}.** <t:${timestamp}:R>`,
        `by <@${w.moderator_id}>`,
      ];

      if (w.reason) {
        const reason =
          w.reason.length > 80 ? w.reason.substring(0, 77) + '...' : w.reason;
        parts.push(`- *${reason}*`);
      }

      return (
        parts.join(' ') +
        `\n   └ Case: \`${w.id}\`  (use \`/case id:${w.id}\`)`
      );
    });

    if (totalFetched < totalCount) {
      lines.push(
        `\n*Showing first ${totalFetched} of ${totalCount} active warnings (fetch limit).*`,
      );
    }

    embed.setDescription(lines.join('\n\n')).setFooter({
      text: `Page ${page + 1}/${totalPages} • Total active warnings: ${totalCount}`,
      iconURL: guild.iconURL({ size: 64 }) ?? undefined,
    });
  }

  // User info field
  embed.addFields({
    name: 'User Information',
    value: [
      `**ID:** \`${user.id}\``,
      `**Created:** <t:${Math.floor(
        user.createdTimestamp / 1000,
      )}:R>`,
    ].join('\n'),
    inline: true,
  });

  return embed;
}

/**
 * Build the pagination row.
 *
 * Custom data kept tiny: { t: targetId, p: page, l: limit }
 * so we stay well under the 100-char customId limit.
 */
function buildWarnsPaginationRow(
  interaction,
  targetId,
  currentPage,
  totalPages,
  limit,
) {
  const row = new ActionRowBuilder();

  const makeButton = (label, style, page, disabled) =>
    new ButtonBuilder()
      .setCustomId(
        makeId(
          'warns',
          'page',
          interaction,
          { t: targetId, p: page, l: limit },
          900, // 15 minutes
        ),
      )
      .setStyle(style)
      .setLabel(label)
      .setDisabled(disabled);

  const isFirst = currentPage <= 0;
  const isLast = currentPage >= totalPages - 1;

  row.addComponents(
    makeButton(WARN_BUTTON_EMOJIS.first, ButtonStyle.Secondary, 0, isFirst),
    makeButton(
      WARN_BUTTON_EMOJIS.prev,
      ButtonStyle.Secondary,
      Math.max(0, currentPage - 1),
      isFirst,
    ),
    makeButton(
      WARN_BUTTON_EMOJIS.next,
      ButtonStyle.Secondary,
      Math.min(totalPages - 1, currentPage + 1),
      isLast,
    ),
    makeButton(
      WARN_BUTTON_EMOJIS.last,
      ButtonStyle.Secondary,
      totalPages - 1,
      isLast,
    ),
  );

  return row;
}
