// src/commands/moderation/purge-invites.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { ensureInGuild, safeReply } from '../../utils/moderation/mod.js';
import { createLogger } from '../../core/logger.js';
import pLimit from 'p-limit';

const log = createLogger({ mod: 'purge-invites' });

// Concurrency for deletions – keep this modest to be kind to the API
const DEL_CONCURRENCY = 4;

/**
 * Utility: partition an array into smaller chunks
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default {
  data: new SlashCommandBuilder()
    .setName('purge-invites')
    .setDescription('Delete server invite links (all, or those older than N days).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addIntegerOption(o =>
      o.setName('days')
        .setDescription('Delete invites older than this many days. If omitted: delete ALL invites.')
        .setMinValue(1)
        .setMaxValue(3650)
    )
    .addBooleanOption(o =>
      o.setName('ephemeral')
        .setDescription('Show confirmation/results ephemerally (default: true).')
    ),

  async execute(interaction) {
    ensureInGuild(interaction);

    const days = interaction.options.getInteger('days', false);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;

    // Permission check for the invoker; bot perms will be checked implicitly on action
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return safeReply(interaction, {
        content: '❌ You need **Manage Server** to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Defer so we can fetch invites
    await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : 0 });

    // Fetch invites (guild-wide)
    let invites;
    try {
      invites = await interaction.guild.invites.fetch({ cache: false });
    } catch (err) {
      log.error({ err, guildId: interaction.guildId }, 'Failed to fetch invites');
      return safeReply(interaction, {
        content: '❌ Failed to fetch invites. Do I have **Manage Server** permission?',
        flags: MessageFlags.Ephemeral,
      });
    }

    const vanity = interaction.guild.vanityURLCode;
    const now = Date.now();
    const cutoffMs = days ? now - days * 24 * 60 * 60 * 1000 : null;

    // Filter target invites
    const targets = invites.filter((inv) => {
      // never touch vanity invite
      if (vanity && inv.code === vanity) return false;

      // Discord returns createdTimestamp on Invite (may be undefined; treat as old)
      const created = inv.createdTimestamp ?? 0;

      if (cutoffMs == null) return true;         // no days → ALL (except vanity)
      return created > 0 ? created <= cutoffMs   // older than N days
                         : true;                 // unknown timestamp → purge
    });

    if (targets.size === 0) {
      return interaction.editReply({
        content: days
          ? `No invites are older than **${days}** day${days === 1 ? '' : 's'}.`
          : 'There are no invites to delete.',
      });
    }

    // Build confirm UI
    const nonce = Math.random().toString(36).slice(2, 10);
    const baseId = `purgeinv:${interaction.id}:${nonce}`; // stable per invocation

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`${baseId}:confirm`)
      .setLabel('Confirm purge')
      .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`${baseId}:cancel`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

    const preview = targets.first(5);
    const previewLines = preview.map(inv => {
      const chan = inv.channel ? `#${inv.channel.name}` : '(unknown channel)';
      const creator = inv.inviter ? `${inv.inviter.tag}` : 'Unknown';
      const ageDays = inv.createdTimestamp ? Math.floor((now - inv.createdTimestamp) / 86400000) : '?';
      return `• \`${inv.code}\` — ${chan} — by ${creator} — ${ageDays}d old`;
    });

    const title =
      days
        ? `Delete ${targets.size} invite(s) older than **${days}d**?`
        : `Delete **ALL** non-vanity invites (${targets.size})?`;

    const embed = new EmbedBuilder()
      .setTitle('Purge Invites — Confirmation')
      .setDescription(title)
      .setColor(0xff6b6b)
      .addFields(
        { name: 'Preview', value: previewLines.join('\n') + (targets.size > 5 ? `\n…and ${targets.size - 5} more` : ''), inline: false }
      )
      .setFooter({ text: 'This action cannot be undone.' });

    await interaction.editReply({ embeds: [embed], components: [row] });

    // --- Component handling (works with ephemeral too) ---
    // If you have a global component router, you can hook by the prefix 'purgeinv:'
    // Otherwise we await the click locally for up to 30s:
    const filter = (i) =>
      i.user.id === interaction.user.id &&
      i.customId.startsWith(baseId);

    let pressed;
    try {
      pressed = await interaction.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter,
        time: 30_000,
      });
    } catch {
      // timeout → disable UI
      return interaction.editReply({
        content: '⏳ Timed out, no action taken.',
        embeds: [],
        components: [],
      });
    }

    if (pressed.customId.endsWith(':cancel')) {
      await pressed.update({ content: '✅ Cancelled.', embeds: [], components: [] });
      return;
    }

    // Confirmed
    await pressed.update({ content: '⏳ Purging invites…', embeds: [], components: [] });

    // Delete with modest concurrency
    const limit = pLimit(DEL_CONCURRENCY);
    let deleted = 0;
    const failures = [];

    // Chunk to avoid a giant burst of promises
    for (const batch of chunk([...targets.values()], 20)) {
      await Promise.allSettled(
        batch.map(inv =>
          limit(async () => {
            try {
              await interaction.guild.invites.delete(inv.code, `Purged by /purge-invites${days ? ` (older than ${days}d)` : ''}`);
              deleted++;
            } catch (err) {
              failures.push({ code: inv.code, err: err?.message || String(err) });
            }
          })
        )
      );
    }

    const resultEmbed = new EmbedBuilder()
      .setTitle('Purge Invites — Result')
      .setColor(failures.length ? 0xffc107 : 0x3fb950)
      .setDescription(
        `Deleted **${deleted}** invite${deleted === 1 ? '' : 's'}`
        + (days ? ` (older than ${days}d)` : ' (all non-vanity)')
      )
      .setTimestamp();

    if (failures.length) {
      const firstFew = failures.slice(0, 5)
        .map(f => `• \`${f.code}\` — ${f.err}`)
        .join('\n');
      resultEmbed.addFields({
        name: `Failed (${failures.length})`,
        value: firstFew + (failures.length > 5 ? `\n…and ${failures.length - 5} more` : ''),
        inline: false,
      });
    }

    return interaction.editReply({ embeds: [resultEmbed] });
  },
};
