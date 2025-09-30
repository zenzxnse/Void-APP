// src/commands/moderation/automod.js - FIXED VERSION
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import { ensureInGuild, safeReply } from "../../utils/moderation/mod.js";
import { query, tx } from "../../core/db/index.js";
import { ensureGuildConfig } from "../../utils/moderation/mod-db.js";
import {
  parseDurationSeconds,
  prettySecs,
} from "../../utils/moderation/duration.js";
import { createLogger } from "../../core/logger.js";
import { getAutoModState } from "../../utils/automod/redis-state.js";

const log = createLogger({ mod: "automod" });

// Updated rule types with proper validation + sane defaults
const RULE_TYPES = {
  spam: {
    name: "Message Spam",
    description: "Detect users sending messages too quickly",
    requiresThreshold: true,
    requiresDuration: true, // (window)
    defaultThreshold: 5,
    defaultWindowSeconds: 5,
    maxThreshold: 50,
    maxWindowSeconds: 300,
    thresholdUnit: "messages",
  },
  channel_spam: {
    name: "Channel Spam",
    description: "Detect users spamming across multiple channels",
    requiresThreshold: true,
    requiresDuration: true,
    defaultThreshold: 3,
    defaultWindowSeconds: 10,
    maxThreshold: 20,
    maxWindowSeconds: 300,
    thresholdUnit: "channels",
  },
  mention_spam: {
    name: "Mention Spam",
    description: "Detect excessive mentions in messages",
    requiresThreshold: true,
    requiresDuration: true,
    defaultThreshold: 4,
    defaultWindowSeconds: 5,
    maxThreshold: 20,
    maxWindowSeconds: 60,
    thresholdUnit: "mentions",
  },
  caps: {
    name: "Excessive Caps",
    description: "Detect messages with too many capital letters",
    requiresThreshold: true,
    requiresDuration: false,
    defaultThreshold: 70,
    maxThreshold: 100,
    thresholdUnit: "percent",
  },
  invite: {
    name: "Discord Invites",
    description: "Detect Discord invite links",
    requiresThreshold: false,
    requiresDuration: false,
    pattern: "discord\\.gg/|discordapp\\.com/invite/",
  },
  link: {
    name: "External Links",
    description: "Detect external links",
    requiresThreshold: false,
    requiresDuration: false,
    pattern: "https?://(?!(?:discord\\.gg|discordapp\\.com))",
  },
  keyword: {
    name: "Prohibited Keywords",
    description: "Detect specific words or phrases",
    requiresThreshold: false,
    requiresDuration: false,
    requiresPattern: true,
  },
  regex: {
    name: "Custom Regex",
    description: "Advanced pattern matching",
    requiresThreshold: false,
    requiresDuration: false,
    requiresPattern: true,
    maxPatternLength: 200,
  },
};

// canonical action names used by runtime
const ACTIONS = ["delete", "warn", "timeout", "kick", "ban", "mute"]; // 'mute' alias → 'timeout'

// For timeout/mute when user forgets: default to 5 minutes
const DEFAULT_ACTION_DURATION_SECONDS = 5 * 60;

// Parse a comma-separated list of actions, normalize, and validate
function parseActions(primaryAction, actionsCsv) {
  const list = new Set();

  // allow either “action” or “actions” (csv)
  if (actionsCsv) {
    for (const raw of actionsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      list.add(raw.toLowerCase());
    }
  }
  if (primaryAction) list.add(primaryAction.toLowerCase());

  // normalize: mute → timeout
  const normalized = [...list].map((a) => (a === "mute" ? "timeout" : a));

  // validate
  const invalid = normalized.filter(
    (a) => !ACTIONS.includes(a) && a !== "timeout"
  ); // 'mute' already mapped
  if (invalid.length) {
    return {
      ok: false,
      error: `Invalid action(s): ${invalid.join(", ")}`,
      actions: [],
    };
  }

  // remove duplicates, preserve a deterministic order by ACTIONS array
  const ordered = ACTIONS.filter((a) => normalized.includes(a)).map((a) =>
    a === "mute" ? "timeout" : a
  );
  // ensure at least one
  if (ordered.length === 0)
    return { ok: false, error: "No valid actions provided", actions: [] };

  // final unique list (e.g., if both mute+timeout were passed)
  return { ok: true, actions: [...new Set(ordered)] };
}

// Validation helper
function validateRoleIds(input) {
  if (!input) return [];
  const ids = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = ids.filter((id) => /^\d{17,20}$/.test(id));
  return valid.slice(0, 10);
}

function validateChannelIds(input) {
  if (!input) return [];
  const ids = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = ids.filter((id) => /^\d{17,20}$/.test(id));
  return valid.slice(0, 20);
}

export default {
  data: new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Configure auto-moderation settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)

    .addSubcommand((sub) =>
      sub.setName("enable").setDescription("Enable auto-moderation system")
    )

    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable auto-moderation rules")
        .addStringOption((o) =>
          o
            .setName("rule")
            .setDescription("Specific rule to disable (leave empty for all)")
            .addChoices(
              ...Object.entries(RULE_TYPES).map(([key, rule]) => ({
                name: rule.name,
                value: key,
              }))
            )
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List all auto-moderation rules")
        .addBooleanOption((o) =>
          o
            .setName("detailed")
            .setDescription("Show detailed rule configuration")
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("addaction")
        .setDescription("Append actions to an existing rule")
        .addStringOption((o) =>
          o
            .setName("actions")
            .setDescription(
              "Comma-separated actions to add (e.g., delete,warn,timeout)"
            )
            .setRequired(true)
            .setMaxLength(100)
        )
        .addStringOption((o) =>
          o
            .setName("rule_key")
            .setDescription(
              "Rule key (e.g., spam_5). If omitted, use type+threshold"
            )
            .setMaxLength(50)
        )
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Rule type (if no rule_key provided)")
            .addChoices(
              ...Object.entries(RULE_TYPES).map(([key, rule]) => ({
                name: rule.name,
                value: key,
              }))
            )
        )
        .addIntegerOption((o) =>
          o
            .setName("threshold")
            .setDescription(
              "Threshold used in rule_key (if no rule_key provided)"
            )
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addStringOption((o) =>
          o
            .setName("duration")
            .setDescription("Duration for timeout if included (e.g., 5m, 1h)")
            .setMaxLength(20)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("delaction")
        .setDescription("Remove actions from an existing rule")
        .addStringOption((o) =>
          o
            .setName("actions")
            .setDescription(
              "Comma-separated actions to remove (e.g., delete,warn,timeout)"
            )
            .setRequired(true)
            .setMaxLength(100)
        )
        .addStringOption((o) =>
          o
            .setName("rule_key")
            .setDescription(
              "Rule key (e.g., spam_5). If omitted, use type+threshold"
            )
            .setMaxLength(50)
        )
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Rule type (if no rule_key provided)")
            .addChoices(
              ...Object.entries(RULE_TYPES).map(([key, rule]) => ({
                name: rule.name,
                value: key,
              }))
            )
        )
        .addIntegerOption((o) =>
          o
            .setName("threshold")
            .setDescription(
              "Threshold used in rule_key (if no rule_key provided)"
            )
            .setMinValue(1)
            .setMaxValue(100)
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("rule")
        .setDescription("Create or update an auto-moderation rule")
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Rule type")
            .setRequired(true)
            .addChoices(
              ...Object.entries(RULE_TYPES).map(([key, rule]) => ({
                name: rule.name,
                value: key,
              }))
            )
        )
        // keep single action for backwards-compat
        .addStringOption((o) =>
          o
            .setName("action")
            .setDescription("Primary action to take when rule is triggered")
            .addChoices(
              { name: "Delete Message", value: "delete" },
              { name: "Warn", value: "warn" },
              { name: "Timeout", value: "timeout" },
              { name: "Kick", value: "kick" },
              { name: "Ban", value: "ban" },
              { name: "Mute (alias of Timeout)", value: "mute" }
            )
        )
        // new: multiple actions (comma-separated)
        .addStringOption((o) =>
          o
            .setName("actions")
            .setDescription(
              "Comma-separated actions (e.g., delete,warn,timeout)"
            )
            .setMaxLength(100)
        )
        .addIntegerOption((o) =>
          o
            .setName("threshold")
            .setDescription("Trigger threshold (varies by rule type)")
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addStringOption((o) =>
          o
            .setName("window")
            .setDescription("Detection time window (e.g., 5s, 1m)")
            .setMaxLength(10)
        )
        .addStringOption((o) =>
          o
            .setName("duration")
            .setDescription("Action duration for timeout (e.g., 5m, 1h)")
            .setMaxLength(20)
        )
        .addStringOption((o) =>
          o
            .setName("pattern")
            .setDescription("Pattern for keyword/regex rules")
            .setMaxLength(200)
        )
        .addStringOption((o) =>
          o
            .setName("exempt_roles")
            .setDescription("Comma-separated role IDs to exempt (max 10)")
            .setMaxLength(250)
        )
        .addStringOption((o) =>
          o
            .setName("exempt_channels")
            .setDescription("Comma-separated channel IDs to exempt (max 20)")
            .setMaxLength(500)
        )
        .addBooleanOption((o) =>
          o
            .setName("enabled")
            .setDescription("Enable this rule (default: true)")
        )
    )

    .addSubcommand((sub) =>
      sub
        .setName("test")
        .setDescription("Test a rule against sample text")
        .addStringOption((o) =>
          o
            .setName("rule_key")
            .setDescription("Rule key to test")
            .setRequired(true)
            .setMaxLength(50)
        )
        .addStringOption((o) =>
          o
            .setName("text")
            .setDescription("Sample text to test")
            .setRequired(true)
            .setMaxLength(2000)
        )
    ),

  cooldownMs: 3000,

  async execute(interaction) {
    ensureInGuild(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const subcommand = interaction.options.getSubcommand();

    try {
      await ensureGuildConfig(interaction.guildId);
      const autoModState = getAutoModState();

      switch (subcommand) {
        case "enable":
          return await handleEnable(interaction, autoModState);
        case "disable":
          return await handleDisable(interaction, autoModState);
        case "list":
          return await handleList(interaction);
        case "rule":
          return await handleRule(interaction, autoModState);
        case "test":
          return await handleTest(interaction);
        case "addaction":
          return await handleAddAction(interaction, autoModState);
        case "delaction":
          return await handleDelAction(interaction, autoModState);
        default:
          return safeReply(interaction, {
            content: "Invalid subcommand.",
            flags: MessageFlags.Ephemeral,
          });
      }
    } catch (err) {
      log.error({ err, guildId: interaction.guildId }, "Automod command error");
      return safeReply(interaction, {
        content: "Failed to process auto-moderation command. Please try again.",
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

async function handleDelAction(interaction, autoModState) {
  const ruleKeyOpt = interaction.options.getString("rule_key");
  const typeOpt = interaction.options.getString("type");
  const threshOpt = interaction.options.getInteger("threshold");
  const actionsCsv = interaction.options.getString("actions", true);

  // parse requested removals (reuse parseActions but ignore primary)
  const parsed = parseActions(null, actionsCsv);
  if (!parsed.ok) {
    return safeReply(interaction, {
      content: parsed.error,
      flags: MessageFlags.Ephemeral,
    });
  }
  const toRemove = new Set(
    parsed.actions.map((a) => (a === "mute" ? "timeout" : a))
  );

  // resolve target rule
  let ruleKey = ruleKeyOpt;
  if (!ruleKey) {
    if (typeOpt && threshOpt != null) {
      ruleKey = `${typeOpt}_${threshOpt}`;
    } else if (typeOpt) {
      const { rows } = await query(
        `SELECT rule_key FROM auto_mod_rules WHERE guild_id = $1 AND type = $2`,
        [interaction.guildId, typeOpt]
      );
      if (rows.length === 0) {
        return safeReply(interaction, {
          content: `No rules found for type \`${typeOpt}\`. Provide a rule_key or a threshold.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (rows.length > 1) {
        const keys = rows.map((r) => `\`${r.rule_key}\``).join(", ");
        return safeReply(interaction, {
          content: `Multiple rules exist for type \`${typeOpt}\`: ${keys}\nPlease specify \`rule_key\` or include \`threshold\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      ruleKey = rows[0].rule_key;
    } else {
      return safeReply(interaction, {
        content:
          "Provide either `rule_key`, or `type` (+ optional `threshold`).",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // load existing rule
  const {
    rows: [rule],
  } = await query(
    `SELECT id, name, type, action, rule_key, rule_data, duration_seconds
       FROM auto_mod_rules
      WHERE guild_id = $1 AND rule_key = $2`,
    [interaction.guildId, ruleKey]
  );
  if (!rule) {
    return safeReply(interaction, {
      content: `Rule \`${ruleKey}\` not found in this guild.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const data = safeJson(rule.rule_data) || {};
  const current =
    Array.isArray(data.actions) && data.actions.length
      ? data.actions
      : rule.action
      ? [rule.action]
      : [];

  // compute new action set
  const after = ACTIONS.filter((a) =>
    current.map((x) => (x === "mute" ? "timeout" : x)).includes(a)
  ).filter((a) => !toRemove.has(a));

  if (after.length === 0) {
    return safeReply(interaction, {
      content:
        "Refused: a rule must keep at least one action. Remove fewer actions or add new ones first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const newData = { ...data, actions: after };

  try {
    const updated = await tx(async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `UPDATE auto_mod_rules
            SET rule_data = $1::jsonb,
                -- keep duration_seconds; it’s harmless even if timeout was removed
                version = auto_mod_rules.version + 1
          WHERE id = $2
        RETURNING *`,
        [JSON.stringify(newData), rule.id]
      );

      await client.query(
        `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          interaction.guildId,
          "automod_rule_del_actions",
          interaction.user.id,
          rule.id,
          JSON.stringify({
            ruleKey: rule.rule_key,
            removed: [...toRemove],
            resulting: after,
          }),
        ]
      );

      return row;
    });

    await autoModState.invalidateGuildConfig(interaction.guildId);

    return safeReply(interaction, {
      content:
        `Updated rule **${rule.name}** (\`${rule.rule_key}\`)\n` +
        `**Actions (now):** ${after.map((a) => a.toUpperCase()).join(" + ")}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log.error({ err, ruleKey }, "Failed to remove actions from rule");
    return safeReply(interaction, {
      content: "Failed to update rule actions.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleAddAction(interaction, autoModState) {
  const ruleKeyOpt = interaction.options.getString("rule_key");
  const typeOpt = interaction.options.getString("type");
  const threshOpt = interaction.options.getInteger("threshold");
  const actionsCsv = interaction.options.getString("actions", true);
  const durationStr = interaction.options.getString("duration");

  // Parse/validate actions (mute → timeout, de-dupe, ordered)
  const parsed = parseActions(null, actionsCsv);
  if (!parsed.ok) {
    return safeReply(interaction, {
      content: parsed.error,
      flags: MessageFlags.Ephemeral,
    });
  }
  const actionsToAdd = parsed.actions; // e.g. ['delete','warn','timeout']

  // Resolve target rule
  let ruleKey = ruleKeyOpt;
  if (!ruleKey) {
    if (typeOpt && threshOpt != null) {
      ruleKey = `${typeOpt}_${threshOpt}`;
    } else if (typeOpt) {
      // If only type supplied, pick the single rule if unambiguous
      const { rows } = await query(
        `SELECT id, rule_key FROM auto_mod_rules WHERE guild_id = $1 AND type = $2`,
        [interaction.guildId, typeOpt]
      );
      if (rows.length === 0) {
        return safeReply(interaction, {
          content: `No rules found for type \`${typeOpt}\`. Provide a rule_key or a threshold.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (rows.length > 1) {
        const keys = rows.map((r) => `\`${r.rule_key}\``).join(", ");
        return safeReply(interaction, {
          content: `Multiple rules exist for type \`${typeOpt}\`: ${keys}\nPlease specify \`rule_key\` or include \`threshold\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      ruleKey = rows[0].rule_key;
    } else {
      return safeReply(interaction, {
        content:
          "Provide either `rule_key`, or `type` (+ optional `threshold`).",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Load the existing rule (and current rule_data/actions)
  const {
    rows: [rule],
  } = await query(
    `SELECT id, name, type, action, rule_key, rule_data, duration_seconds
     FROM auto_mod_rules
     WHERE guild_id = $1 AND rule_key = $2`,
    [interaction.guildId, ruleKey]
  );

  if (!rule) {
    return safeReply(interaction, {
      content: `Rule \`${ruleKey}\` not found in this guild.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const existingData = safeJson(rule.rule_data) || {};
  const existingActions =
    Array.isArray(existingData.actions) && existingData.actions.length
      ? existingData.actions
      : rule.action
      ? [rule.action]
      : [];

  // Merge, normalize & order by canonical ACTIONS order
  const mergedSet = new Set(
    [...existingActions, ...actionsToAdd].map((a) =>
      a === "mute" ? "timeout" : a
    )
  );
  const orderedMerged = ACTIONS.filter((a) => mergedSet.has(a)).map((a) =>
    a === "mute" ? "timeout" : a
  );

  // Duration logic for timeout
  let newTimeoutSeconds = null;
  const includesTimeout = orderedMerged.includes("timeout");
  if (includesTimeout) {
    if (durationStr) {
      const parsedDur = parseDurationSeconds(durationStr);
      if (!parsedDur || parsedDur <= 0) {
        return safeReply(interaction, {
          content: "Invalid `duration` format. Examples: 5m, 1h, 1d",
          flags: MessageFlags.Ephemeral,
        });
      }
      newTimeoutSeconds = parsedDur;
    } else {
      // Keep existing duration if present, else default to 5m
      newTimeoutSeconds =
        rule.duration_seconds ?? DEFAULT_ACTION_DURATION_SECONDS;
    }
  }

  // Build new rule_data (preserve existing fields e.g. window_seconds)
  const newRuleData = { ...existingData, actions: orderedMerged };

  try {
    const updated = await tx(async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `UPDATE auto_mod_rules
         SET rule_data = $1::jsonb,
             duration_seconds = CASE WHEN $2::int IS NOT NULL THEN $2 ELSE duration_seconds END,
             version = auto_mod_rules.version + 1
         WHERE id = $3
         RETURNING *`,
        [JSON.stringify(newRuleData), newTimeoutSeconds, rule.id]
      );

      await client.query(
        `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          interaction.guildId,
          "automod_rule_add_actions",
          interaction.user.id,
          rule.id,
          JSON.stringify({
            ruleKey: rule.rule_key,
            added: actionsToAdd,
            resulting: orderedMerged,
            newTimeoutSeconds: includesTimeout
              ? newTimeoutSeconds ?? null
              : null,
          }),
        ]
      );

      return row;
    });

    await autoModState.invalidateGuildConfig(interaction.guildId);

    const bits = [];
    bits.push(`Updated rule **${rule.name}** (\`${rule.rule_key}\`)`);
    bits.push(
      `**Actions (now):** ${orderedMerged
        .map((a) => a.toUpperCase())
        .join(" + ")}`
    );
    if (includesTimeout) {
      const t = newTimeoutSeconds ?? updated.duration_seconds;
      bits.push(`**Timeout Duration:** ${prettySecs(t)}`);
    }

    return safeReply(interaction, {
      content: bits.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log.error({ err, ruleKey }, "Failed to add actions to rule");
    return safeReply(interaction, {
      content: "Failed to update rule actions.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleEnable(interaction, autoModState) {
  // If already enabled, just say so; otherwise enable.
  const { rows } = await query(
    `SELECT auto_mod_enabled FROM guild_config WHERE guild_id = $1`,
    [interaction.guildId]
  );
  const already = rows[0]?.auto_mod_enabled === true;

  if (!already) {
    await tx(async (client) => {
      await client.query(
        `UPDATE guild_config
         SET auto_mod_enabled = TRUE, updated_at = NOW()
         WHERE guild_id = $1`,
        [interaction.guildId]
      );
      // lightweight audit
      await client.query(
        `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
         VALUES ($1, $2, $3, NULL, $4)`,
        [
          interaction.guildId,
          "automod_enable",
          interaction.user.id,
          JSON.stringify({ timestamp: Date.now() }),
        ]
      );
    });
    await autoModState.invalidateGuildConfig(interaction.guildId);
  }

  return safeReply(interaction, {
    content: already
      ? "Auto-moderation is already enabled."
      : "Auto-moderation enabled.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDisable(interaction, autoModState) {
  const ruleType = interaction.options.getString("rule");

  const result = await tx(async (client) => {
    if (!ruleType) {
      await client.query(
        `UPDATE guild_config
         SET auto_mod_enabled = FALSE, updated_at = NOW()
         WHERE guild_id = $1`,
        [interaction.guildId]
      );

      const { rowCount } = await client.query(
        `UPDATE auto_mod_rules
         SET enabled = FALSE
         WHERE guild_id = $1 AND enabled = TRUE`,
        [interaction.guildId]
      );

      await client.query(
        `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
         VALUES ($1, $2, $3, NULL, $4)`,
        [
          interaction.guildId,
          "automod_disable_all",
          interaction.user.id,
          JSON.stringify({ rulesDisabled: rowCount }),
        ]
      );

      return { type: "all", count: rowCount };
    } else {
      const { rowCount } = await client.query(
        `UPDATE auto_mod_rules
         SET enabled = FALSE
         WHERE guild_id = $1 AND type = $2 AND enabled = TRUE`,
        [interaction.guildId, ruleType]
      );

      if (rowCount > 0) {
        await client.query(
          `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
           VALUES ($1, $2, $3, NULL, $4)`,
          [
            interaction.guildId,
            "automod_disable_rule",
            interaction.user.id,
            JSON.stringify({ ruleType, rulesDisabled: rowCount }),
          ]
        );
      }

      return { type: "specific", count: rowCount, ruleType };
    }
  });

  await autoModState.invalidateGuildConfig(interaction.guildId);

  if (result.type === "all") {
    return safeReply(interaction, {
      content: `Auto-moderation system disabled${
        result.count > 0
          ? `\nDisabled ${result.count} rule${result.count !== 1 ? "s" : ""}`
          : ""
      }`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    if (result.count === 0) {
      return safeReply(interaction, {
        content: `No ${
          RULE_TYPES[result.ruleType]?.name || result.ruleType
        } rules found to disable.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return safeReply(interaction, {
      content: `Disabled ${result.count} ${
        RULE_TYPES[result.ruleType]?.name || result.ruleType
      } rule${result.count !== 1 ? "s" : ""}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleList(interaction) {
  const detailed = interaction.options.getBoolean("detailed") ?? false;

  const [systemResult, rulesResult] = await Promise.all([
    query(`SELECT auto_mod_enabled FROM guild_config WHERE guild_id = $1`, [
      interaction.guildId,
    ]),
    query(
      `
      SELECT id, rule_key, name, type, action, threshold, pattern, enabled, quarantined,
             rule_data, exempt_roles, exempt_channels, created_at, version
      FROM auto_mod_rules
      WHERE guild_id = $1
      ORDER BY type, name
    `,
      [interaction.guildId]
    ),
  ]);

  const systemEnabled = systemResult.rows[0]?.auto_mod_enabled ?? false;
  const rules = rulesResult.rows;

  const embed = new EmbedBuilder()
    .setTitle("Auto-Moderation Configuration")
    .setColor(systemEnabled ? 0x00ff00 : 0xff0000)
    .setTimestamp()
    .setFooter({
      text: interaction.guild.name,
      iconURL: interaction.guild.iconURL({ dynamic: true }),
    });

  embed.addFields({
    name: "System Status",
    value: systemEnabled ? "Enabled" : "Disabled",
    inline: true,
  });

  if (rules.length === 0) {
    embed.setDescription(
      "No auto-moderation rules configured.\n\nUse `/automod rule` to create your first rule."
    );
    return safeReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  }

  const activeRules = rules.filter((r) => r.enabled && !r.quarantined).length;
  const quarantined = rules.filter((r) => r.quarantined).length;

  embed.addFields({
    name: "Rules Summary",
    value: `${activeRules}/${rules.length} active rules${
      quarantined > 0 ? `\n${quarantined} quarantined` : ""
    }`,
    inline: true,
  });

  // derive actions list (rule_data.actions or single action)
  const displayActions = (rule) => {
    const d =
      rule.rule_data &&
      (typeof rule.rule_data === "object"
        ? rule.rule_data
        : safeJson(rule.rule_data));
    const acts =
      Array.isArray(d?.actions) && d.actions.length
        ? d.actions
        : rule.action
        ? [rule.action]
        : [];
    return acts.map((a) => a.toUpperCase()).join(" + ");
  };

  if (detailed) {
    const grouped = rules.reduce((acc, r) => {
      (acc[r.type] ||= []).push(r);
      return acc;
    }, {});

    for (const [type, typeRules] of Object.entries(grouped)) {
      const ruleInfo = RULE_TYPES[type] || { name: type };
      const lines = typeRules.map((rule) => {
        const status = rule.quarantined
          ? "QUARANTINED"
          : rule.enabled
          ? "ACTIVE"
          : "DISABLED";
        const unit = RULE_TYPES[type]?.thresholdUnit || "";
        const tStr = rule.threshold
          ? ` (${rule.threshold}${unit ? " " + unit : ""})`
          : "";
        const acts = displayActions(rule);
        return `**${rule.name}**: ${status} → ${acts}${tStr} [v${
          rule.version ?? 1
        }]`;
      });

      embed.addFields({
        name: `${ruleInfo.name} (${typeRules.length})`,
        value: lines.join("\n").slice(0, 1024),
        inline: false,
      });
    }
  } else {
    const summary = Object.entries(
      rules.reduce((acc, rule) => {
        const t = rule.type;
        acc[t] ||= { active: 0, total: 0, quarantined: 0 };
        acc[t].total++;
        if (rule.quarantined) acc[t].quarantined++;
        else if (rule.enabled) acc[t].active++;
        return acc;
      }, {})
    ).map(([type, stats]) => {
      const ruleInfo = RULE_TYPES[type];
      return `**${ruleInfo?.name || type}**: ${stats.active}/${
        stats.total
      } active${
        stats.quarantined > 0 ? ` (${stats.quarantined} quarantined)` : ""
      }`;
    });

    embed.addFields({
      name: "Rule Types",
      value: summary.join("\n"),
      inline: false,
    });
  }

  return safeReply(interaction, {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

function safeJson(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
}

async function handleRule(interaction, autoModState) {
  const type = interaction.options.getString("type", true);
  const primaryAction = interaction.options.getString("action"); // optional now
  const actionsCsv = interaction.options.getString("actions"); // comma separated (optional)
  const thresholdOpt = interaction.options.getInteger("threshold");
  const windowStr = interaction.options.getString("window");
  const durationStr = interaction.options.getString("duration");
  const pattern = interaction.options.getString("pattern")?.trim();
  const exemptRolesStr = interaction.options.getString("exempt_roles");
  const exemptChannelsStr = interaction.options.getString("exempt_channels");
  const enabled = interaction.options.getBoolean("enabled") ?? true;

  const ruleInfo = RULE_TYPES[type];
  if (!ruleInfo) {
    return safeReply(interaction, {
      content: "Invalid rule type.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Parse + validate actions (allow multiple). Map mute → timeout.
  const parsedActions = parseActions(primaryAction, actionsCsv);
  if (!parsedActions.ok) {
    return safeReply(interaction, {
      content: parsedActions.error,
      flags: MessageFlags.Ephemeral,
    });
  }
  const actions = parsedActions.actions; // array like ['delete','warn','timeout']
  const primary = actions[0]; // stored in legacy 'action' column

  // Validation with defaults
  const errors = [];

  // Threshold (apply default if required and missing)
  let threshold = thresholdOpt ?? null;
  if (ruleInfo.requiresThreshold) {
    if (threshold == null) threshold = ruleInfo.defaultThreshold ?? 5;
    if (threshold > (ruleInfo.maxThreshold ?? Number.MAX_SAFE_INTEGER)) {
      errors.push(
        `Threshold cannot exceed ${ruleInfo.maxThreshold} ${
          ruleInfo.thresholdUnit || ""
        } for ${ruleInfo.name}`
      );
    }
    if (threshold < 1)
      errors.push(`Threshold must be at least 1 for ${ruleInfo.name}`);
  }

  // Window seconds (apply default if rule uses a time window)
  let windowSeconds = null;
  if (windowStr) {
    const parsed = parseDurationSeconds(windowStr);
    if (!parsed || parsed <= 0)
      errors.push("Invalid window format. Examples: 5s, 1m");
    else if (ruleInfo.maxWindowSeconds && parsed > ruleInfo.maxWindowSeconds) {
      errors.push(
        `Window cannot exceed ${prettySecs(ruleInfo.maxWindowSeconds)}`
      );
    } else {
      windowSeconds = parsed;
    }
  } else if (ruleInfo.requiresDuration) {
    windowSeconds = ruleInfo.defaultWindowSeconds ?? 5;
  }

  // Action duration (only needed when timeout is present)
  let actionDurationSeconds = null;
  if (actions.includes("timeout")) {
    if (durationStr) {
      const parsed = parseDurationSeconds(durationStr);
      if (!parsed || parsed <= 0)
        errors.push("Invalid duration format. Examples: 5m, 1h, 1d");
      else actionDurationSeconds = parsed;
    } else {
      // default to 5m if missing
      actionDurationSeconds = DEFAULT_ACTION_DURATION_SECONDS;
    }
  }

  // Pattern validation
  if (ruleInfo.requiresPattern && !pattern)
    errors.push(`${ruleInfo.name} requires a pattern`);
  if (pattern && type === "regex") {
    if (pattern.length > (ruleInfo.maxPatternLength || 200)) {
      errors.push(
        `Regex pattern too long (max ${
          ruleInfo.maxPatternLength || 200
        } characters)`
      );
    }
    try {
      new RegExp(pattern, "giu");
    } catch (err) {
      errors.push(`Invalid regex pattern: ${err.message}`);
    }
  }

  // Exemptions
  const exemptRoles = validateRoleIds(exemptRolesStr);
  const exemptChannels = validateChannelIds(exemptChannelsStr);
  if (exemptRolesStr && exemptRoles.length === 0)
    errors.push("No valid role IDs found in exempt_roles");
  if (exemptChannelsStr && exemptChannels.length === 0)
    errors.push("No valid channel IDs found in exempt_channels");

  if (errors.length > 0) {
    return safeReply(interaction, {
      content: "Rule validation failed:\n• " + errors.join("\n• "),
      flags: MessageFlags.Ephemeral,
    });
  }

  // Build rule_data
  const ruleData = {};
  if (windowSeconds) ruleData.window_seconds = windowSeconds;
  if (actions?.length) ruleData.actions = actions;

  // Generate rule key + display name
  const ruleKey = `${type}_${threshold ?? "default"}`;
  const ruleName = `${ruleInfo.name}${
    threshold
      ? ` (${threshold}${
          ruleInfo.thresholdUnit ? " " + ruleInfo.thresholdUnit : ""
        })`
      : ""
  }`;

  try {
    const result = await tx(async (client) => {
      // Enable system politely (idempotent)
      await client.query(
        `UPDATE guild_config
         SET auto_mod_enabled = TRUE, updated_at = NOW()
         WHERE guild_id = $1`,
        [interaction.guildId]
      );

      // Upsert rule - NOTE: qualify version to avoid ambiguity
      const {
        rows: [rule],
      } = await client.query(
        `INSERT INTO auto_mod_rules (
           guild_id, rule_key, name, type, pattern, action, threshold,
           duration_seconds, rule_data, exempt_roles, exempt_channels, enabled
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT (guild_id, rule_key)
         DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           pattern = EXCLUDED.pattern,
           action = EXCLUDED.action,
           threshold = EXCLUDED.threshold,
           duration_seconds = EXCLUDED.duration_seconds,
           rule_data = EXCLUDED.rule_data,
           exempt_roles = EXCLUDED.exempt_roles,
           exempt_channels = EXCLUDED.exempt_channels,
           enabled = EXCLUDED.enabled,
           quarantined = FALSE,
           error_count = 0,
           last_error_at = NULL,
           version = auto_mod_rules.version + 1
         RETURNING *`,
        [
          interaction.guildId,
          ruleKey,
          ruleName,
          type,
          pattern || RULE_TYPES[type]?.pattern || null,
          primary, // legacy single 'action' for compatibility
          threshold,
          actionDurationSeconds,
          JSON.stringify(ruleData),
          exemptRoles.length ? exemptRoles : null,
          exemptChannels.length ? exemptChannels : null,
          enabled,
        ]
      );

      // lightweight audit
      await client.query(
        `INSERT INTO audit_logs (guild_id, action_type, actor_id, target_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          interaction.guildId,
          "automod_rule_create",
          interaction.user.id,
          rule.id,
          JSON.stringify({
            ruleKey: rule.rule_key,
            ruleName: rule.name,
            ruleType: rule.type,
            actions: actions,
            primaryAction: primary,
            threshold: rule.threshold,
            enabled: rule.enabled,
            version: rule.version,
          }),
        ]
      );

      return rule;
    });

    await autoModState.invalidateGuildConfig(interaction.guildId);

    const bits = [];
    bits.push("Created/updated auto-moderation rule");
    bits.push(`**Name:** ${result.name}`);
    bits.push(`**Type:** ${RULE_TYPES[type].name}`);
    bits.push(
      `**Actions:** ${actions.map((a) => a.toUpperCase()).join(" + ")}${
        actions.includes("timeout") && primaryAction === "mute"
          ? " (mute → TIMEOUT)"
          : ""
      }`
    );
    if (threshold)
      bits.push(
        `**Threshold:** ${threshold} ${RULE_TYPES[type]?.thresholdUnit || ""}`
      );
    if (ruleData.window_seconds)
      bits.push(`**Detection Window:** ${prettySecs(ruleData.window_seconds)}`);
    if (actionDurationSeconds && actions.includes("timeout"))
      bits.push(`**Timeout Duration:** ${prettySecs(actionDurationSeconds)}`);
    if (pattern)
      bits.push(
        `**Pattern:** \`${pattern.substring(0, 50)}${
          pattern.length > 50 ? "..." : ""
        }\``
      );
    if (exemptRoles.length)
      bits.push(`**Exempt Roles:** ${exemptRoles.length}`);
    if (exemptChannels.length)
      bits.push(`**Exempt Channels:** ${exemptChannels.length}`);
    bits.push(`**Status:** ${enabled ? "Enabled" : "Disabled"}`);

    return safeReply(interaction, {
      content: bits.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log.error({ err }, "Failed to create auto-mod rule");
    return safeReply(interaction, {
      content: "Failed to create auto-moderation rule.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleTest(interaction) {
  const ruleKey = interaction.options.getString("rule_key", true);
  const testText = interaction.options.getString("text", true);

  return safeReply(interaction, {
    content: `Test functionality not yet implemented.\n\nRule: \`${ruleKey}\`\nText: \`${testText.substring(
      0,
      100
    )}${testText.length > 100 ? "..." : ""}\``,
    flags: MessageFlags.Ephemeral,
  });
}
