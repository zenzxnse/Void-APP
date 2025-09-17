// src/commands/moderation/purge-reactions.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { ensureInGuild, safeReply, canPurgeChannel } from '../../utils/moderation/mod.js';
import { logAudit } from '../../utils/moderation/mod-db.js';
import { createLogger } from '../../core/logger.js';
import RateLimiter from '../../utils/rateLimiter.js';

const log = createLogger({ mod: 'purge-reactions' });

// Parse an emoji input that can be:
//  - Unicode emoji (e.g. 😄)
//  - Custom emoji mention like <:name:1234567890> or <a:name:1234567890>
function parseEmojiInput(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Custom emoji mention
  const m = s.match(/^<a?:([\w~]+):(\d+)>$/);
  if (m) {
    return { id: m[2], name: m[1], type: 'custom' };
  }

  // If it contains colons like :name:, be lenient and treat as name
  if (/^:/.test(s) && /:$/.test(s)) {
    return { id: null, name: s.slice(1, -1), type: 'name' };
  }

  // Otherwise assume unicode (one or more codepoints)
  return { id: null, name: s, type: 'unicode' };
}

function emojiMatches(reaction, target) {
  // reaction.emoji has .id (for custom) and .name (unicode or custom name)
  if (!target) return true;
  if (target.id) return reaction.emoji.id === target.id;
  // For unicode or name-only match on .name
  return reaction.emoji.name === target.name;
}

export default {
  data: new SlashCommandBuilder()
    .setName('purge-reactions')
    .setDescription('Remove reactions from recent messages in this channel')
    .addIntegerOption(o => o
      .setName('messages')
      .setDescription('How many recent messages to scan (1-500)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(500))
    .addUserOption(o => o
      .setName('user')
      .setDescription('Only remove reactions made by this user'))
    .addStringOption(o => o
      .setName('emoji')
      .setDescription('Only remove this emoji (e.g., 😄 or <:name:id>)')
      .setMaxLength(64))
    .addBooleanOption(o => o
      .setName('exclude_pinned')
      .setDescription('Skip pinned messages (default: true)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  requiredBotPerms: [
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ViewChannel
  ],
  cooldownMs: 3000,

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    // Progress ping for long scans
    await interaction.editReply('🔎 Scanning recent messages…');

    const channel = interaction.channel;
    if (!canPurgeChannel(channel)) {
      return safeReply(interaction, {
        content: '❌ Cannot purge reactions in this channel type.',
        ephemeral: true
      });
    }

    const scanCount = interaction.options.getInteger('messages', true);
    const targetUser = interaction.options.getUser('user') ?? null;
    const emojiRaw = interaction.options.getString('emoji');
    const targetEmoji = parseEmojiInput(emojiRaw);
    const excludePinned = interaction.options.getBoolean('exclude_pinned') ?? true;
    const hasFilters = targetUser || targetEmoji;

    const limiter = new RateLimiter();
    const start = Date.now();

    let scanned = 0;
    let touchedMessages = 0;
    let removedReactions = 0;
    let failedOps = 0;
    let lastId = null;

    try {
      while (scanned < scanCount) {
        const batch = await channel.messages.fetch({
          limit: Math.min(100, scanCount - scanned),
          ...(lastId && { before: lastId })
        });
        if (batch.size === 0) break;

        for (const [, msg] of batch) {
          if (scanned >= scanCount) break;
          scanned++;
          lastId = msg.id;

          if (excludePinned && msg.pinned) continue;
          if (msg.reactions.cache.size === 0) continue;

          let messageTouched = false;

          // Optimized path for no filters (nuke all)
          if (!hasFilters) {
            try {
              const totalOnMessage = msg.reactions.cache.reduce((sum, r) => sum + r.count, 0);
              if (totalOnMessage > 0) {
                await msg.reactions.removeAll();
                removedReactions += totalOnMessage;
                messageTouched = true;
              }
            } catch (err) {
              failedOps++;
              log.debug({ err, messageId: msg.id }, 'removeAll failed');
            }
          } else {
            // Path with filters (user and/or emoji)
            for (const [, reaction] of msg.reactions.cache) {
              if (!emojiMatches(reaction, targetEmoji)) continue;

              try {
                if (targetUser) {
                  // Attempt removal directly. If it fails, the catch block will handle it gracefully.
                  await reaction.users.remove(targetUser.id);
                  removedReactions++;
                  messageTouched = true;
                } else { // targetEmoji is guaranteed to be set here
                  const countInStack = reaction.count;
                  await reaction.remove();
                  removedReactions += countInStack;
                  messageTouched = true;
                }
              } catch (err) {
                if (targetUser) {
                  // This error is expected if the user hadn't reacted with this specific emoji.
                  // We log for debugging but don't count it as a hard failure.
                  log.debug({ err, messageId: msg.id, userId: targetUser.id }, 'User reaction remove failed (likely not present)');
                } else {
                  // This is an unexpected failure (e.g., permissions).
                  failedOps++;
                  log.debug({ err, messageId: msg.id, emoji: reaction.emoji.name }, 'Reaction removal failed');
                }
              }
              await limiter.wait();
            }
          }

          if (messageTouched) touchedMessages++;

          // Safety against the 15-minute limit
          if (Date.now() - start > 14.5 * 60 * 1000) {
            log.warn('Approaching interaction timeout; stopping early.');
            break;
          }
        }

        if (Date.now() - start > 14.5 * 60 * 1000) break;
      }

      // Audit
      await logAudit({
        guildId: interaction.guildId,
        actionType: 'purge_reactions',
        actorId: interaction.user.id,
        targetId: channel.id,
        details: {
          channelName: channel.name,
          scanned,
          touchedMessages,
          removedReactions,
          failedOps,
          filters: {
            user: targetUser?.id || null,
            emoji: emojiRaw || null,
            excludePinned
          }
        }
      });

      const pieces = [
        `✅ **Removed ${removedReactions} reaction${removedReactions !== 1 ? 's' : ''} from ${touchedMessages} message${touchedMessages !== 1 ? 's' : ''}**`,
        `🔎 Scanned: ${scanned} messages`,
        targetUser ? `👤 User filter: ${targetUser.tag}` : null,
        targetEmoji ? `😀 Emoji filter: ${emojiRaw}` : null,
        excludePinned ? '📌 Pinned messages skipped' : null,
        failedOps ? `⚠️ Failures: ${failedOps}` : null
      ].filter(Boolean);

      return safeReply(interaction, { content: pieces.join('\n'), ephemeral: true });

    } catch (err) {
      log.error({ err, channelId: channel.id }, 'purge-reactions failed');
      return safeReply(interaction, {
        content: '❌ Failed to purge reactions. Check my permissions and try again.',
        ephemeral: true
      });
    }
  }
};
