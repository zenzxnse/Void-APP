// src/commands/moderation/unban.js - FIXED VERSION
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { ensureInGuild, safeReply, normalizeReason } from '../../utils/moderation/mod.js';
import { createInfractionWithCount, logAudit } from '../../utils/moderation/mod-db.js';
import { tx } from '../../core/db/index.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'unban' });

// Cache for ban lists (guild -> { bans: Collection, expires: timestamp })
const banCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export default {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user from the server')
    .addStringOption(o => o
      .setName('user')
      .setDescription('User ID or username to unban')
      .setRequired(true)
      .setMaxLength(100))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Reason for unbanning')
      .setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),

  requiredBotPerms: [PermissionFlagsBits.BanMembers],

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const userInput = interaction.options.getString('user', true).trim();
    const reason = normalizeReason(interaction.options.getString('reason')) || 'No reason provided';

    // Basic snowflake validation
    const isSnowflake = /^\d{17,20}$/.test(userInput);
    
    try {
      let userId = null;
      let ban = null;

      // Try direct fetch if it's a valid snowflake
      if (isSnowflake) {
        try {
          ban = await interaction.guild.bans.fetch(userInput);
          userId = userInput;
        } catch (err) {
          if (err.code !== 10026) throw err; // Unknown ban
        }
      }

      // If not found by ID, search by username (with caching for large ban lists)
      if (!ban) {
        const guildId = interaction.guildId;
        const cached = banCache.get(guildId);
        let bans;

        if (cached && cached.expires > Date.now()) {
          bans = cached.bans;
          log.debug({ guildId }, 'Using cached ban list');
        } else {
          // For large guilds, this could be slow
          const memberCount = interaction.guild.memberCount;
          if (memberCount > 10000) {
            log.warn({ guildId, memberCount }, 'Fetching ban list for large guild');
          }

          try {
            bans = await interaction.guild.bans.fetch();
            
            // Cache the result
            banCache.set(guildId, {
              bans,
              expires: Date.now() + CACHE_TTL
            });

            // Clean old cache entries
            if (banCache.size > 100) {
              const now = Date.now();
              for (const [key, value] of banCache) {
                if (value.expires < now) {
                  banCache.delete(key);
                }
              }
            }
          } catch (err) {
            if (err.code === 50001) {
              return safeReply(interaction, {
                content: '❌ I lack permission to view the ban list.',
                flags: MessageFlags.Ephemeral
              });
            }
            throw err;
          }
        }

        // Search by username (case-insensitive)
        const searchLower = userInput.toLowerCase();
        ban = bans.find(b => 
          b.user.username.toLowerCase() === searchLower ||
          b.user.tag.toLowerCase() === searchLower ||
          b.user.globalName?.toLowerCase() === searchLower
        );
        
        if (ban) {
          userId = ban.user.id;
        }
      }

      if (!ban) {
        return safeReply(interaction, {
          content: '❌ User not found in ban list. Check the user ID or username.',
          flags: MessageFlags.Ephemeral
        });
      }

      // Use transaction for unban + job cancellation
      const result = await tx(async (client) => {
        // Cancel any pending unban jobs
        const { rows: cancelledJobs } = await client.query(
          `DELETE FROM scheduled_jobs 
           WHERE type = 'unban' 
             AND guild_id = $1 
             AND user_id = $2 
             AND run_at > NOW()
           RETURNING id, data`,
          [interaction.guildId, userId]
        );

        // Update any active ban infractions
        await client.query(
          `UPDATE infractions 
           SET active = FALSE 
           WHERE guild_id = $1 
             AND user_id = $2 
             AND type = 'ban' 
             AND active = TRUE`,
          [interaction.guildId, userId]
        );

        return { cancelledJobs };
      });

      // Unban the user
      await interaction.guild.bans.remove(userId, `[${interaction.user.tag}] ${reason.substring(0, 400)}`);

      // Clear cache for this guild
      banCache.delete(interaction.guildId);

      // Create unban infraction record
      const infraction = await createInfractionWithCount({
        guildId: interaction.guildId,
        userId: userId,
        moderatorId: interaction.user.id,
        type: 'unban',
        reason: reason,
      });

      // Try to DM the user about unban
      let dmSent = false;
      try {
        const user = await interaction.client.users.fetch(userId);
        await user.send({
          content: `✅ **You have been unbanned from ${interaction.guild.name}**\n📝 **Reason:** ${reason}\n\nYou may now rejoin the server if you have an invite.`
        });
        dmSent = true;
      } catch (err) {
        log.debug({ userId, error: err.message }, 'Could not DM user about unban');
      }

      // Log to audit
      await logAudit({
        guildId: interaction.guildId,
        actionType: 'unban',
        actorId: interaction.user.id,
        targetId: userId,
        details: {
          username: ban.user.tag,
          reason,
          caseId: infraction.id,
          cancelledJobs: result.cancelledJobs.length,
          dmSent
        }
      });

      return safeReply(interaction, {
        content: [
          `✅ **Unbanned ${ban.user.tag}**`,
          `📋 **Case ID:** \`${infraction.id}\``,
          `📝 **Reason:** ${reason}`,
          result.cancelledJobs.length > 0 ? `⚠️ Cancelled ${result.cancelledJobs.length} scheduled unban${result.cancelledJobs.length > 1 ? 's' : ''}` : null,
          dmSent ? '📬 User was notified via DM' : '⚠️ Could not DM user'
        ].filter(Boolean).join('\n'),
        flags: MessageFlags.Ephemeral
      });

    } catch (err) {
      log.error({ err }, 'Unban failed');
      
      if (err.code === 10026) {
        return safeReply(interaction, {
          content: '❌ That user is not banned.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (err.code === 50013) {
        return safeReply(interaction, {
          content: '❌ I lack permissions to unban users.',
          flags: MessageFlags.Ephemeral
        });
      }

      return safeReply(interaction, {
        content: '❌ Failed to unban user. Please check my permissions.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};