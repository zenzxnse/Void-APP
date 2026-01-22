// src/components/registerAppinvitesComponents.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { SecureCustomId, makeId } from './ComponentRouter.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ mod: 'appinvites:components' });

// Rebuild the pager row with freshly signed custom IDs
function buildPagerRow(ix, currentPage, totalPages) {
  if (totalPages <= 1) return [];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', ix, { page: 0 }, 900))
      .setLabel('⏮️ First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),

    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', ix, { page: currentPage - 1 }, 900))
      .setLabel('◀️ Prev')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),

    new ButtonBuilder()
      .setCustomId('page_indicator')
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),

    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', ix, { page: currentPage + 1 }, 900))
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage >= totalPages - 1),

    new ButtonBuilder()
      .setCustomId(makeId('appinvites', 'page', ix, { page: totalPages - 1 }, 900))
      .setLabel('Last ⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
  );
  return [row];
}

export function registerAppinvitesComponents(router) {
  // Pagination button: appinvites:page
  router.button('appinvites:page', {
    name: 'appinvites_page',
    defer: 'update',        // edit the original message
    persistent: false,      // state lives in memory map with TTL
    replayScope: 'user',    // lock to the caller
    dmPermission: false,
    guildOnly: true,
    cooldownMs: 400,

    async execute(interaction /*, ctx */) {
      // 1) Validate and parse the signed custom id (caller-only, anti-replay)
      const parsed = SecureCustomId.parse(interaction.customId, interaction);
      if (!parsed) {
        return interaction.editReply({ content: 'This pager expired. Re-run **/appinvites**.' });
      }
      const target = Number((parsed.data.custom || {}).page ?? 0);

      // 2) Retrieve caller-scoped pages stored by the slash command
      const key = `${interaction.guildId}-${interaction.user.id}`;
      const bag = interaction.client.appinvitePages?.get(key);

      if (!bag || !Array.isArray(bag.pages) || bag.pages.length === 0) {
        return interaction.editReply({ content: 'Nothing to show. Re-run **/appinvites**.' });
      }
      if (bag.expires && Date.now() > bag.expires) {
        interaction.client.appinvitePages.delete(key);
        return interaction.editReply({ content: 'Results expired. Re-run **/appinvites**.' });
      }

      // 3) Clamp target page and rebuild fresh buttons (new signatures)
      const total = bag.pages.length;
      const page = Math.max(0, Math.min(target, total - 1));
      const components = buildPagerRow(interaction, page, total);

      // 4) Update the original message
      return interaction.editReply({
        content: bag.pages[page],
        components,
      });
    },
  });

  log.info('Registered appinvites:page component handler');
}
