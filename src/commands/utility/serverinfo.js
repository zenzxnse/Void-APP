// src/commands/utility/serverinfo.js
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  GuildVerificationLevel,
  GuildNSFWLevel,
  GuildMFALevel,
} from 'discord.js';
import { ensureInGuild, tryDM, safeReply } from '../../utils/moderation/mod.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ mod: 'serverinfo' });

// Labels
const VerificationText = {
  [GuildVerificationLevel.None]: 'None',
  [GuildVerificationLevel.Low]: 'Low (verified email)',
  [GuildVerificationLevel.Medium]: 'Medium (5m on Discord)',
  [GuildVerificationLevel.High]: 'High (10m in server)',
  [GuildVerificationLevel.VeryHigh]: 'Highest (phone verified)',
};
const NSFWText = {
  [GuildNSFWLevel.Default]: 'Default',
  [GuildNSFWLevel.Explicit]: 'Explicit',
  [GuildNSFWLevel.Safe]: 'Safe',
  [GuildNSFWLevel.AgeRestricted]: 'Age Restricted',
};
const fmtVerification = v => VerificationText[v] ?? 'Unknown';
const fmtNSFW = v => NSFWText[v] ?? 'Unknown';

export default {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Show information about this server.')
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Reply only visible to you (default: true)'))
    .addBooleanOption(o => o.setName('detailed').setDescription('Force full member fetch (slow for large servers; default: false)'))
    .addBooleanOption(o => o.setName('dm').setDescription('Send the stats to your DMs instead')),

  async execute(interaction) {
    ensureInGuild(interaction);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
    const detailed  = interaction.options.getBoolean('detailed') ?? false;

    // Defer using the same pattern as /userinfo
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);

    const g = await interaction.guild.fetch();

    // Owner
    let ownerTag = 'Unknown';
    try {
      const ownerMember = await g.members.fetch(g.ownerId);
      ownerTag = `${ownerMember.user.tag} (${ownerMember.id})`;
    } catch {}

    // Channels
    const channels = await g.channels.fetch().catch(() => g.channels.cache);
    const counts = { categories: 0, text: 0, voice: 0, stage: 0, forum: 0, announcement: 0, threads: 0 };
    channels.forEach(ch => {
      switch (ch?.type) {
        case ChannelType.GuildCategory: counts.categories++; break;
        case ChannelType.GuildText: counts.text++; break;
        case ChannelType.GuildVoice: counts.voice++; break;
        case ChannelType.GuildStageVoice: counts.stage++; break;
        case ChannelType.GuildForum: counts.forum++; break;
        case ChannelType.GuildAnnouncement: counts.announcement++; break;
        case ChannelType.PublicThread:
        case ChannelType.PrivateThread:
        case ChannelType.AnnouncementThread: counts.threads++; break;
        default: break;
      }
    });

    // Member counts
    let totalHumans, totalBots, onlineHumans, onlineTotal, countNote = '';
    if (detailed || g.memberCount < 1000) {
      try {
        const members = await g.members.fetch();
        totalHumans   = members.filter(m => !m.user.bot).size;
        totalBots     = members.filter(m =>  m.user.bot).size;
        onlineHumans  = members.filter(m => !m.user.bot && m.presence?.status !== 'offline').size;
        onlineTotal   = members.filter(m => m.presence?.status !== 'offline').size;
      } catch (err) {
        log.warn({ err, guildId: g.id }, 'Full member fetch failed; falling back to cache');
        const cached   = g.members.cache;
        totalHumans    = cached.filter(m => !m.user.bot).size;
        totalBots      = cached.filter(m =>  m.user.bot).size;
        onlineHumans   = cached.filter(m => !m.user.bot && m.presence?.status !== 'offline').size;
        onlineTotal    = cached.filter(m => m.presence?.status !== 'offline').size;
        countNote      = ' (cache-based)';
      }
    } else {
      // Approximate mode
      const approxOnline = g.approximatePresenceCount ?? 0;
      // No direct human/bot split without full fetch; present a conservative split
      onlineTotal  = approxOnline;
      totalHumans  = Math.max(0, g.memberCount - Math.floor(g.memberCount * 0.03)); // guess 3% bots if unknown
      totalBots    = g.memberCount - totalHumans;
      onlineHumans = Math.max(0, approxOnline - Math.ceil(totalBots * 0.2)); // assume fewer bots online
      countNote    = ' (approximate; use **detailed** for exact)';
    }

    // Vanity URL
    let vanity = null;
    try { vanity = g.vanityURLCode ? `discord.gg/${g.vanityURLCode}` : null; } catch {}

    const created  = Math.floor(g.createdTimestamp / 1000);
    const features = g.features?.length
      ? g.features.slice(0, 25).map(f => `\`${f}\``).join(' • ') + (g.features.length > 25 ? '...' : '')
      : 'None';

    try {
      const embed = new EmbedBuilder()
        .setTitle(`Server Info — ${g.name}`)
        .setThumbnail(g.iconURL({ size: 256 }))
        .setColor(0x4098ff)
        .addFields(
          {
            name: 'Overview',
            value: [
              `**ID:** \`${g.id}\``,
              `**Owner:** ${ownerTag}`,
              `**Created:** <t:${created}:F> (<t:${created}:R>)`,
              `**Members:** ${g.memberCount.toLocaleString()} (Humans: ${totalHumans.toLocaleString()}, Bots: ${totalBots.toLocaleString()})${countNote}`,
              `**Online:** ~${onlineTotal.toLocaleString()} (Humans: ~${onlineHumans.toLocaleString()})${countNote}`,
              `**Boosts:** Tier ${g.premiumTier} (${g.premiumSubscriptionCount ?? 0})`,
            ].join('\n'),
            inline: false,
          },
          {
            name: 'Security',
            value: [
              `**Verification:** ${fmtVerification(g.verificationLevel)}`,
              `**NSFW Level:** ${fmtNSFW(g.nsfwLevel)}`,
              `**2FA Required:** ${g.mfaLevel === GuildMFALevel.Elevated ? 'Yes' : 'No'}`,
            ].join('\n'),
            inline: true,
          },
          {
            name: 'Channels',
            value: [
              `🗂️ Categories: **${counts.categories}**`,
              `# Text: **${counts.text}**, 📣 Announce: **${counts.announcement}**`,
              `🔊 Voice: **${counts.voice}**, 🎙️ Stage: **${counts.stage}**`,
              `🧵 Threads: **${counts.threads}**, 🗃️ Forum: **${counts.forum}**`,
            ].join('\n'),
            inline: true,
          },
          {
            name: 'Assets',
            value: [
              `**Emojis:** ${g.emojis?.cache?.size ?? 0}`,
              `**Stickers:** ${g.stickers?.cache?.size ?? 0}`,
              vanity ? `**Vanity:** ${vanity}` : null,
            ].filter(Boolean).join('\n'),
            inline: true,
          },
          { name: 'Features', value: features, inline: false },
        )
        .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

      // EXACTLY like /userinfo: try to DM if user asked; otherwise respond (ephemeral configurable)
      return tryDM(interaction, embed, ephemeral);
    } catch (err) {
      log.error({ err }, 'Embed construction failed');
      // Fallback text response
      return safeReply(interaction, {
        content: `Server Info for ${g.name} (ID: ${g.id})\nCreated: <t:${created}:F>\nMembers: ${g.memberCount} (${totalHumans} humans, ${totalBots} bots)${countNote}\nOnline: ~${onlineTotal}\nChannels: ${Object.values(counts).reduce((a, b) => a + b, 0)}\nFeatures: ${features || 'None'}`,
        ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
      });
    }
  },
};