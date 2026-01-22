// src/components/warnComponents.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { getActiveWarnCount, getUserWarns } from '../utils/moderation/mod-db.js';
import { makeId } from './ComponentRouter.js';

// Keep in sync with warns.js
const PAGE_SIZE = 10;

export const WARN_BUTTON_EMOJIS = {
  first: '⏮️',
  prev: '◀️',
  next: '▶️',
  last: '⏭️',
};

/**
 * Register warns pagination components
 * @param {import('./ComponentRouter.js').default} router
 */
export function registerWarnComponents(router) {
  router.button('warns:page', {
    defer: 'none',        // we call interaction.update ourselves
    callerOnly: true,     // only the original command user
    persistent: false,    // no DB persistence needed here

    async execute(interaction, context) {
      const { parsed, client, log } = context;
      const custom = parsed?.data?.custom || {};

      const targetId = custom.t;
      let page = Number(custom.p ?? 0);
      const limit = Number(custom.l ?? 25);

      if (!targetId) {
        return interaction.reply({
          content: '❌ Missing data for pagination.',
          ephemeral: true,
        });
      }

      try {
        const targetUser = await client.users.fetch(targetId).catch(() => null);

        const [count, list] = await Promise.all([
          getActiveWarnCount(interaction.guildId, targetId),
          getUserWarns(interaction.guildId, targetId, limit),
        ]);

        const totalFetched = list.length;
        const totalPages = Math.max(
          1,
          Math.ceil(totalFetched / PAGE_SIZE),
        );

        // Clamp page
        if (!Number.isFinite(page) || page < 0) page = 0;
        if (page > totalPages - 1) page = totalPages - 1;

        const pageWarns = paginate(list, page, PAGE_SIZE);

        const embed = buildWarnsPageEmbed({
          user: targetUser ?? { id: targetId, tag: `Unknown (${targetId})` },
          guild: interaction.guild,
          warns: pageWarns,
          totalCount: count,
          totalFetched,
          page,
          totalPages,
          pageSize: PAGE_SIZE,
        });

        const components =
          totalPages > 1
            ? [
                buildWarnsPaginationRow(
                  interaction,
                  targetId,
                  page,
                  totalPages,
                  limit,
                ),
              ]
            : [];

        await interaction.update({
          embeds: [embed],
          components,
        });
      } catch (err) {
        log.error({ err }, 'warns pagination update failed');
        try {
          await interaction.reply({
            content: '❌ Failed to update warnings page.',
            ephemeral: true,
          });
        } catch {
          // swallow
        }
      }
    },
  });
}

// ---------- Helpers (duplicated from warns.js to avoid circular imports) ----------

function paginate(list, page, pageSize) {
  const start = page * pageSize;
  return list.slice(start, start + pageSize);
}

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
  const tag = user.tag ?? `User ${user.id}`;
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Warnings for ${tag}`)
    .setColor(totalCount > 0 ? 0xffa500 : 0x00ff00)
    .setTimestamp();

  if (user.displayAvatarURL) {
    embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
  }

  if (warns.length === 0) {
    embed
      .setDescription('✅ No active warnings found.')
      .setFooter({ text: 'Clean record' });
  } else {
    const lines = warns.map((w, idx) => {
      const absoluteIndex = page * pageSize + idx + 1;
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

  embed.addFields({
    name: 'User Information',
    value: [`**ID:** \`${user.id}\``].join('\n'),
    inline: true,
  });

  return embed;
}

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
          900,
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
