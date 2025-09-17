import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { getActiveWarnCount, getUserWarns } from '../../utils/moderation/mod-db.js';

export default {
  data: new SlashCommandBuilder()
    .setName('warns')
    .setDescription('Show warnings for a member.')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addBooleanOption(o => o.setName('ephemeral').setDescription("Bot's reply will be ephemeral (only visible to you)"))
    .addIntegerOption(o => o.setName('limit').setDescription('Maximum warnings to show (default: 25)').setMinValue(1).setMaxValue(50))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  async execute(interaction) {
    ensureInGuild(interaction);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
    const limit = interaction.options.getInteger('limit') ?? 25;
    
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    const user = interaction.options.getUser('user', true);

    try {
      // Get warn count and list
      const [count, list] = await Promise.all([
        getActiveWarnCount(interaction.guildId, user.id),
        getUserWarns(interaction.guildId, user.id, limit)
      ]);

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Warnings for ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 128 }))
        .setColor(count > 0 ? 0xFFA500 : 0x00FF00) // Orange if has warns, green if clean
        .setTimestamp();

      if (list.length === 0) {
        embed.setDescription('✅ No active warnings found.')
          .setFooter({ text: 'Clean record' });
      } else {
        // Format warning list
        const lines = list.map((w, i) => {
          const timestamp = Math.floor(new Date(w.created_at).getTime() / 1000);
          const parts = [
            `**${i + 1}.** <t:${timestamp}:R>`,
            `by <@${w.moderator_id}>`,
          ];
          
          if (w.reason) {
            // Truncate reason if too long
            const reason = w.reason.length > 50 
              ? w.reason.substring(0, 47) + '...' 
              : w.reason;
            parts.push(`- *${reason}*`);
          }
          
          // Add case ID on new line for clarity
          return parts.join(' ') + `\n   └ Case: \`${w.id}\`  (use /case id:${w.id})`;
        });

        // Check if we hit the limit
        const hasMore = list.length === limit;
        if (hasMore) {
          lines.push(`\n*... and possibly more (showing first ${limit})*`);
        }

        embed.setDescription(lines.join('\n\n'))
          .setFooter({ 
            text: `Total active warnings: ${count}`,
            iconURL: interaction.guild.iconURL({ dynamic: true })
          });

        // Add field with quick stats
        if (count >= 3) {
          embed.addFields({
            name: '⚠️ Warning',
            value: 'This user has multiple active warnings and may be subject to automatic moderation actions.',
            inline: false
          });
        }
      }

      // Add user info field
      embed.addFields({
        name: 'User Information',
        value: [
          `**ID:** \`${user.id}\``,
          `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
        ].join('\n'),
        inline: true
      });

      return safeReply(interaction, {
        embeds: [embed],
        ...(ephemeral && { flags: MessageFlags.Ephemeral })
      });
      
    } catch (err) {
      console.error('Warns command error:', err);
      return safeReply(interaction, {
        content: '❌ Failed to fetch warnings. Please try again or contact an administrator.',
        flags: MessageFlags.Ephemeral
      });
    }
  },
};

