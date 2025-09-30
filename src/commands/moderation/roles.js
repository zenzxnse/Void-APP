// src/commands/mod/roles.js
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

import {
  ensureInGuild,
  checkHierarchy,
  safeReply,
  normalizeReason,
  humanizeError,
} from "../../utils/moderation/mod.js";

// --- utils ---
const ROLE_MENTION_RE = /<@&(\d+)>/g;

function parseRoleMentions(str) {
  if (!str) return [];
  const ids = new Set();
  for (const m of str.matchAll(ROLE_MENTION_RE)) ids.add(m[1]);
  return [...ids];
}

function filterAssignableRoles(guild, actor, roles) {
  const me = guild.members.me;
  const botTop = me?.roles?.highest?.position ?? 0;
  const actorTop = actor?.roles?.highest?.position ?? 0;

  return roles.filter((r) => {
    if (!r) return false;
    if (r.managed) return false; // integration/linked roles
    if (r.id === guild.id) return false; // @everyone
    if (r.position >= botTop) return false; // bot can't manage
    if (r.position >= actorTop) return false; // actor can't manage
    return r.editable === true; // discord.js “bot can edit” guard
  });
}

function fmtRoleList(roles) {
  return roles.length ? roles.map((r) => `<@&${r.id}>`).join(", ") : "—";
}

export const data = new SlashCommandBuilder()
  .setName("roles")
  .setDescription("Add or clear roles on a member.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Add roles to a member.")
      .addUserOption((o) =>
        o.setName("target").setDescription("Member to modify").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("roles")
          .setDescription("Role mentions to add")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason (audit log)")
      )
      .addBooleanOption((o) =>
        o.setName("silent").setDescription("Only you can see the reply")
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("clear")
      .setDescription("Clear ALL roles from a member, except any you specify.")
      .addUserOption((o) =>
        o.setName("target").setDescription("Member to modify").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("except").setDescription("Role mentions to KEEP (optional)")
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Reason (audit log)")
      )
      .addBooleanOption((o) =>
        o.setName("silent").setDescription("Only you can see the reply")
      )
  );

export async function execute(interaction) {
  ensureInGuild(interaction);

  const guild = interaction.guild;
  const me = guild.members.me;

  // Basic permission guards
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles, true)
  ) {
    return safeReply(interaction, {
      content: "You need **Manage Roles** to do that.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles, true)) {
    return safeReply(interaction, {
      content: "I need **Manage Roles** to do that.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const sub = interaction.options.getSubcommand(true);
  const target = interaction.options.getMember("target", true);
  const reason = normalizeReason(interaction.options.getString("reason"));
  const silent = interaction.options.getBoolean("silent") ?? true; // default to ephemeral

  // Member-level hierarchy guard (actor/bot > target’s top role)
  {
    const h = checkHierarchy({ guild, me, actor: interaction.member, target });
    if (!h.ok) {
      return safeReply(interaction, {
        content: humanizeError(h.why),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (sub === "add") {
    const raw = interaction.options.getString("roles", true);
    const ids = parseRoleMentions(raw);
    if (!ids.length) {
      return safeReply(interaction, {
        content: "No valid role mentions found.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const roles = ids.map((id) => guild.roles.cache.get(id)).filter(Boolean);
    const assignable = filterAssignableRoles(guild, interaction.member, roles);

    const missingIds = new Set(assignable.map((r) => r.id));
    for (const rid of target.roles.cache.keys()) missingIds.delete(rid);
    const toAdd = assignable.filter((r) => missingIds.has(r.id));

    if (!toAdd.length) {
      return safeReply(interaction, {
        content:
          "Nothing to add (either already has them, or they’re not assignable).",
        flags: silent ? MessageFlags.Ephemeral : 0,
      });
    }

    await target.roles.add(
      toAdd,
      reason || `roles add by ${interaction.user.tag}`
    );

    const emb = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("Roles added")
      .setDescription(
        `**Member:** ${target}\n**Added:** ${fmtRoleList(toAdd)}\n**Reason:** ${
          reason || "—"
        }`
      );

    return safeReply(interaction, {
      embeds: [emb],
      flags: silent ? MessageFlags.Ephemeral : 0,
    });
  }

  if (sub === "clear") {
    const exceptRaw = interaction.options.getString("except") || "";
    const exceptIds = new Set(parseRoleMentions(exceptRaw));

    // Current roles on the member
    const current = [...target.roles.cache.values()];

    // Keep: @everyone, managed roles, any in "except"
    const candidates = current.filter(
      (r) => r.id !== guild.id && !r.managed && !exceptIds.has(r.id)
    );

    const removable = filterAssignableRoles(
      guild,
      interaction.member,
      candidates
    );
    if (!removable.length) {
      return safeReply(interaction, {
        content:
          "There’s nothing I can remove (either nothing left after exceptions, or not assignable).",
        flags: silent ? MessageFlags.Ephemeral : 0,
      });
    }

    await target.roles.remove(
      removable,
      reason || `roles clear by ${interaction.user.tag}`
    );

    const kept = current.filter((r) => !removable.some((x) => x.id === r.id));

    const emb = new EmbedBuilder()
      .setColor(0xffa940)
      .setTitle("Roles cleared")
      .addFields([
        { name: 'Removed', value: fmtRoleList(removable) || '—', inline: false },
        { name: 'Kept', value: fmtRoleList(kept) || '—', inline: false },
      ])
      .setFooter({ text: reason ? `Reason: ${reason}` : "No reason provided" });

    return safeReply(interaction, {
      embeds: [emb],
      flags: silent ? MessageFlags.Ephemeral : 0,
    });
  }

  // Fallback
  return safeReply(interaction, {
    content: "Unknown subcommand.",
    flags: MessageFlags.Ephemeral,
  });
}

export default { data, execute };
