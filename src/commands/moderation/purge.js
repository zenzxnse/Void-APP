// src/commands/moderation/purge.js - REWRITTEN (adds `except_user`)
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  Collection,
} from 'discord.js';
import { ensureInGuild, safeReply, canPurgeChannel } from '../../utils/moderation/mod.js';
import { logAudit } from '../../utils/moderation/mod-db.js';
import { createLogger } from '../../core/logger.js';
import RateLimiter from '../../utils/rateLimiter.js';

const log = createLogger({ mod: 'purge' });

// Safety cap for comma-separated terms
const MAX_CONTAINS_TERMS = 12;

/**
 * Parses a comma-separated string into a sorted array of unique, lowercase terms.
 * @param {string} raw The raw string from the command option.
 * @returns {string[]} An array of processed keywords.
 */
function parseContainsTerms(raw) {
  const terms = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toLowerCase());

  const uniq = [...new Set(terms)];
  uniq.sort((a, b) => b.length - a.length);
  return uniq.slice(0, MAX_CONTAINS_TERMS);
}

export default {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk delete messages in this channel')
    .addIntegerOption(o => o
      .setName('count')
      .setDescription('Number of messages to delete (1-100)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100))
    .addUserOption(o => o
      .setName('user')
      .setDescription('Only delete messages from this user'))
    .addUserOption(o => o
      .setName('except_user')
      .setDescription('Delete messages except from this user'))
    .addStringOption(o => o
      .setName('contains')
      .setDescription('Comma-separated keywords; message must contain ALL (case-insensitive)')
      .setMaxLength(200))
    .addBooleanOption(o => o
      .setName('bots')
      .setDescription('Only delete messages from bots'))
    .addBooleanOption(o => o
      .setName('attachments')
      .setDescription('Only delete messages with attachments'))
    .addBooleanOption(o => o
      .setName('exclude_pinned')
      .setDescription('Skip pinned messages (default: true)')),

  requiredBotPerms: [
    PermissionFlagsBits.ManageMessages, 
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ViewChannel
  ],
  cooldownMs: 3000,

  async execute(interaction) {
    ensureInGuild(interaction);
    
    const startTime = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;
    if (!canPurgeChannel(channel)) {
      return safeReply(interaction, {
        content: '❌ Cannot purge messages in this channel type.',
        status: 'error',
        ephemeral: true
      });
    }

    const count = interaction.options.getInteger('count', true);
    const targetUser = interaction.options.getUser('user');
    const exceptUser = interaction.options.getUser('except_user'); // NEW
    const containsRaw = interaction.options.getString('contains');
    const containsTerms = containsRaw ? parseContainsTerms(containsRaw) : null;
    const botsOnly = interaction.options.getBoolean('bots');
    const attachmentsOnly = interaction.options.getBoolean('attachments');
    const excludePinned = interaction.options.getBoolean('exclude_pinned') ?? true;

    // Mutually exclusive: user vs except_user
    if (targetUser && exceptUser) {
      return safeReply(interaction, {
        content: '❌ You can’t use **user** and **except_user** at the same time.',
        status: 'warn',
        ephemeral: true
      });
    }

    const hasFilters = !!(
      targetUser ||
      exceptUser ||
      (containsTerms && containsTerms.length) ||
      botsOnly ||
      attachmentsOnly
    );

    const rateLimiter = new RateLimiter();

    try {
      let allMessages = new Collection();
      let lastId = null;
      let totalFetched = 0;
      const maxFetch = hasFilters ? Math.min(count * 3, 500) : count;

      while (allMessages.size < count && totalFetched < maxFetch) {
        const fetchOptions = {
          limit: Math.min(100, maxFetch - totalFetched),
          ...(lastId && { before: lastId })
        };

        const batch = await channel.messages.fetch(fetchOptions);
        if (batch.size === 0) break;

        // Apply filters
        let filtered = batch;
        if (excludePinned) {
          filtered = filtered.filter(m => !m.pinned);
        }
        if (targetUser) {
          filtered = filtered.filter(m => m.author.id === targetUser.id);
        } else if (exceptUser) { // NEW
          filtered = filtered.filter(m => m.author.id !== exceptUser.id);
        }
        if (containsTerms && containsTerms.length) {
          filtered = filtered.filter(m => {
            if (!m.content) return false;
            const text = m.content.toLowerCase();
            for (let i = 0; i < containsTerms.length; i++) {
              if (text.indexOf(containsTerms[i]) === -1) return false;
            }
            return true;
          });
        }
        if (botsOnly) {
          filtered = filtered.filter(m => m.author.bot);
        }
        if (attachmentsOnly) {
          filtered = filtered.filter(m => m.attachments.size > 0);
        }

        allMessages = allMessages.concat(filtered);
        totalFetched += batch.size;
        lastId = batch.last()?.id;

        if (allMessages.size >= count) {
          allMessages = new Collection([...allMessages].slice(0, count));
          break;
        }
        
        await rateLimiter.wait();
      }

      if (allMessages.size === 0) {
        return safeReply(interaction, {
          content: `❌ No messages found matching your criteria${totalFetched >= maxFetch ? ' (reached search limit)' : ''}.`,
          status: 'warn',
          ephemeral: true
        });
      }

      const now = Date.now();
      const twoWeeks = 14 * 24 * 60 * 60 * 1000;
      const young = allMessages.filter(m => now - m.createdTimestamp < twoWeeks);
      const old = allMessages.filter(m => now - m.createdTimestamp >= twoWeeks);

      let deleted = 0;
      let failed = 0;

      if (young.size > 0) {
        if (young.size === 1) {
          try {
            await young.first().delete();
            deleted = 1;
          } catch (err) {
            failed = 1;
            log.debug({ err }, 'Could not delete single message');
          }
        } else {
          try {
            const result = await channel.bulkDelete(young, true);
            deleted += result.size;
            failed += young.size - result.size;
          } catch (err) {
            log.error({ err }, 'Bulk delete failed');
            throw err;
          }
        }
      }

      if (old.size > 0) {
        for (const message of old.values()) {
          try {
            await message.delete();
            deleted++;
            rateLimiter.reset();
          } catch (err) {
            failed++;
            log.debug({ err, messageId: message.id }, 'Could not delete old message');
          }
          await rateLimiter.wait();
          if (Date.now() - startTime > 840000) { // 14 minutes
            log.warn('Near 15-minute interaction limit, stopping purge early');
            break;
          }
        }
      }

      await logAudit({
        guildId: interaction.guildId,
        actionType: 'purge',
        actorId: interaction.user.id,
        targetId: channel.id,
        details: {
          channelName: channel.name,
          deleted,
          failed,
          requested: count,
          filters: {
            user: targetUser?.id,
            exceptUser: exceptUser?.id, // NEW
            contains: containsRaw,
            botsOnly,
            attachmentsOnly,
            excludePinned
          },
          totalSearched: totalFetched
        }
      });

      const filterDesc = [];
      if (targetUser) filterDesc.push(`from ${targetUser.tag}`);
      if (exceptUser) filterDesc.push(`excluding ${exceptUser.tag}`); // NEW
      if (containsTerms && containsTerms.length) {
        const preview = containsTerms
          .slice(0, 5)
          .map(t => `"${t.length > 20 ? t.slice(0, 17) + '…' : t}"`)
          .join(' AND ');
        const more = containsTerms.length > 5 ? ` +${containsTerms.length - 5} more` : '';
        filterDesc.push(`containing ${preview}${more}`);
      }
      if (botsOnly) filterDesc.push('from bots');
      if (attachmentsOnly) filterDesc.push('with attachments');
      if (excludePinned) filterDesc.push('excluding pinned');

      const warningParts = [];
      if (failed > 0) warningParts.push(`${failed} failed`);
      if (old.size > 0) warningParts.push('some >14 days old');
      if (totalFetched >= maxFetch) warningParts.push('search limit reached');

      return safeReply(interaction, {
        content: [
          `✅ **Deleted ${deleted} message${deleted !== 1 ? 's' : ''}**`,
          filterDesc.length ? `🔍 Filters: ${filterDesc.join(', ')}` : null,
          warningParts.length ? `⚠️ Note: ${warningParts.join(', ')}` : null
        ].filter(Boolean).join('\n'),
        ephemeral: true
      });

    } catch (err) {
      log.error({ err, channelId: channel.id }, 'Purge failed');
      return safeReply(interaction, {
        content: '❌ Failed to delete messages. Please check my permissions and try again.',
        status: 'error',
        ephemeral: true
      });
    }
  },
};
