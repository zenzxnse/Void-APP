const cooldowns = new Map();
const OWNER_IDS = new Set((process.env.OWNER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));

async function isOwner(interaction) {
  if (OWNER_IDS.size) return OWNER_IDS.has(interaction.user.id);
  await interaction.client.application?.fetch().catch(() => {});
  const owner = interaction.client.application?.owner;
  if (!owner) return false;
  if (owner.id) return interaction.user.id === owner.id;
  return owner.members?.has(interaction.user.id) ?? false;
}

function hasPerms(interaction, requiredPerms) {
  if (!interaction.inGuild()) return false;
  const mp = interaction.memberPermissions;
  return !!mp && requiredPerms.every(p => mp.has(p));
}

export async function runMiddleware(interaction, command) {
  const { client } = interaction;
  function bump(reason) { client.stats.denies[reason] = (client.stats.denies[reason] || 0) + 1; }

  const {
    cooldownMs,
    requiredPerms = [],
    guildOnly = false,
    ownerOnly = false,
    dmPermission = true,
  } = command;

  if (!dmPermission && !interaction.inGuild()) { bump('dmBlocked'); return deny('This command can’t be used in DMs.'); }
  if (guildOnly && !interaction.inGuild()) { bump('guildOnly'); return deny('This command is guild-only.'); }
  if (ownerOnly && !(await isOwner(interaction))) { bump('owner'); return deny('Only the bot owner can use this command.'); }
  if (requiredPerms.length && !hasPerms(interaction, requiredPerms)) { bump('perms'); return deny('You lack required permissions for this command.'); }

  if (cooldownMs && cooldownMs > 0) {
    const scope = interaction.guildId ?? 'dm';
    const key = `${scope}:${command.data.name}:${interaction.user.id}`;
    const now = Date.now();
    const exp = cooldowns.get(key) || 0;
    if (now < exp) {
      bump('cooldown');
      const rem = Math.ceil((exp - now) / 1000);
      return deny(`On cooldown: ${rem}s remaining.`);
    }
    const newExp = now + cooldownMs;
    cooldowns.set(key, newExp);
    setTimeout(() => { if (cooldowns.get(key) === newExp) cooldowns.delete(key); }, cooldownMs + 1000);
  }

  return { ok: true };

  async function deny(msg) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
    return { ok: false };
  }
}