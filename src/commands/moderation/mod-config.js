import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { 
  setWarnThreshold, 
  listWarnThresholds, 
  removeWarnThreshold, 
  logAudit 
} from '../../utils/moderation/mod-db.js';
import { parseDurationSeconds, prettySecs } from '../../utils/moderation/duration.js';

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure moderation settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommandGroup(group => group
      .setName('warn')
      .setDescription('Configure warn thresholds')
      .addSubcommand(sub => sub
        .setName('set')
        .setDescription('Set action for a warn threshold')
        .addIntegerOption(o => o
          .setName('threshold')
          .setDescription('Warn count (e.g., 3)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(20))
        .addStringOption(o => o
          .setName('action')
          .setDescription('Action to take')
          .setRequired(true)
          .addChoices(
            { name: '❌ None', value: 'none' },
            { name: '⏰ Timeout', value: 'timeout' },
            { name: '🔇 Mute', value: 'mute' },
            { name: '👢 Kick', value: 'kick' },
            { name: '🔨 Ban', value: 'ban' },
            { name: '🔄 Softban', value: 'softban' },
          ))
        .addStringOption(o => o
          .setName('duration')
          .setDescription('Duration for temp actions (e.g., 1d 2h)')
          .setRequired(false))
      )
      .addSubcommand(sub => sub
        .setName('list')
        .setDescription('List current warn thresholds')
      )
      .addSubcommand(sub => sub
        .setName('remove')
        .setDescription('Remove a warn threshold')
        .addIntegerOption(o => o
          .setName('threshold')
          .setDescription('Warn count to remove')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(20))
      )
    ),

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    // Validate subcommand group
    if (group !== 'warn') {
      return safeReply(interaction, { 
        content: '❌ Invalid configuration group.', 
        flags: MessageFlags.Ephemeral 
      });
    }

    try {
      switch (subcommand) {
        case 'set': {
          const threshold = interaction.options.getInteger('threshold', true);
          const action = interaction.options.getString('action', true);
          const durationStr = interaction.options.getString('duration');

          let durationSeconds = null;
          const TEMP_ACTIONS = new Set(['timeout', 'mute', 'ban', 'softban']);
          const NEEDS_DURATION = TEMP_ACTIONS.has(action);

          // Validate duration for temporary actions
          if (NEEDS_DURATION) {
            if (!durationStr) {
              return safeReply(interaction, {
                content: `❌ The **${action}** action requires a duration.\nExample: \`1d 2h\` for 1 day and 2 hours.`,
                flags: MessageFlags.Ephemeral
              });
            }

            durationSeconds = parseDurationSeconds(durationStr);
            if (!durationSeconds || durationSeconds <= 0) {
              return safeReply(interaction, {
                content: '❌ Invalid duration format.\nExamples: `15m`, `2h`, `1d`, `1d 6h`',
                flags: MessageFlags.Ephemeral
              });
            }

            // Action-specific duration limits
            const limits = {
              timeout: 28 * 24 * 60 * 60, // 28 days (Discord limit)
              mute: 90 * 24 * 60 * 60,    // 90 days
              ban: 365 * 24 * 60 * 60,    // 1 year
              softban: 7 * 24 * 60 * 60,  // 7 days max for softban
            };

            if (limits[action] && durationSeconds > limits[action]) {
              return safeReply(interaction, {
                content: `❌ Duration for **${action}** cannot exceed **${prettySecs(limits[action])}**.`,
                flags: MessageFlags.Ephemeral
              });
            }
          } else if (durationStr) {
            return safeReply(interaction, {
              content: `❌ Duration is only valid for temporary actions (timeout, mute, ban, softban).\nThe **${action}** action is permanent.`,
              flags: MessageFlags.Ephemeral
            });
          }

          // Set the threshold
          const row = await setWarnThreshold({ 
            guildId: interaction.guildId, 
            threshold, 
            action, 
            durationSeconds 
          });

          // Log the change
          await logAudit({
            guildId: interaction.guildId,
            actionType: 'config_warn_set',
            actorId: interaction.user.id,
            details: { threshold, action, durationSeconds }
          });

          // Build response
          const actionEmoji = {
            none: '❌',
            timeout: '⏰',
            mute: '🔇',
            kick: '👢',
            ban: '🔨',
            softban: '🔄',
          }[action] || '❓';

          const duration = row.duration_seconds 
            ? ` for **${prettySecs(row.duration_seconds)}**` 
            : '';

          return safeReply(interaction, {
            content: `✅ **Threshold configured**\n` +
              `${actionEmoji} At **${row.threshold}** warnings → **${row.action}**${duration}`,
            flags: MessageFlags.Ephemeral
          });
        }

        case 'list': {
          const thresholds = await listWarnThresholds(interaction.guildId);

          if (thresholds.length === 0) {
            return safeReply(interaction, { 
              content: '📋 No warn thresholds configured.\n\n' +
                'Use `/config warn set` to configure automatic actions at specific warning counts.',
              flags: MessageFlags.Ephemeral 
            });
          }

          // Build embed
          const embed = new EmbedBuilder()
            .setTitle('⚠️ Warning Threshold Configuration')
            .setColor(0xFFA500)
            .setDescription('Automatic actions triggered at specific warning counts:')
            .setTimestamp()
            .setFooter({ 
              text: interaction.guild.name,
              iconURL: interaction.guild.iconURL({ dynamic: true })
            });

          // Group thresholds by action type for better display
          const lines = thresholds
            .sort((a, b) => a.threshold - b.threshold)
            .map(t => {
              const actionEmoji = {
                none: '❌',
                timeout: '⏰',
                mute: '🔇',
                kick: '👢',
                ban: '🔨',
                softban: '🔄',
              }[t.action] || '❓';

              const duration = t.duration_seconds 
                ? ` (${prettySecs(t.duration_seconds)})` 
                : '';

              return `${actionEmoji} **${t.threshold} warns** → ${t.action}${duration}`;
            });

          embed.addFields({
            name: 'Active Thresholds',
            value: lines.join('\n') || 'None configured',
            inline: false
          });

          return safeReply(interaction, { 
            embeds: [embed], 
            flags: MessageFlags.Ephemeral 
          });
        }

        case 'remove': {
          const threshold = interaction.options.getInteger('threshold', true);
          const deleted = await removeWarnThreshold(interaction.guildId, threshold);

          if (!deleted) {
            return safeReply(interaction, { 
              content: `❌ No threshold found for **${threshold}** warnings.`, 
              flags: MessageFlags.Ephemeral 
            });
          }

          // Log the removal
          await logAudit({
            guildId: interaction.guildId,
            actionType: 'config_warn_remove',
            actorId: interaction.user.id,
            details: { threshold },
          });

          return safeReply(interaction, { 
            content: `✅ Removed threshold for **${threshold}** warnings.`, 
            flags: MessageFlags.Ephemeral 
          });
        }

        default:
          return safeReply(interaction, { 
            content: '❌ Invalid subcommand.', 
            flags: MessageFlags.Ephemeral 
          });
      }
    } catch (err) {
      console.error('Config command error:', err);
      return safeReply(interaction, {
        content: '❌ Failed to update configuration. Please try again or contact an administrator.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};
