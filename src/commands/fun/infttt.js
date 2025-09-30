// Infinite TicTacToe — Command
// Mode: vs Computer or PvP (two players)
// Persists game state in persistent_components

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { ensureInGuild, safeReply } from "../../utils/moderation/mod.js";
import { createLogger } from "../../core/logger.js";
import { query } from "../../core/db/index.js";
import { SecureCustomId } from "../../components/ComponentRouter.js";

const log = createLogger({ mod: "infttt" });
const COMPONENT_TYPE = "ttt:board";
const COMPONENT_KEY = "ttt"; // one row per message

export default {
  data: new SlashCommandBuilder()
    .setName("infttt")
    .setDescription(
      "Play Infinite Tic-Tac-Toe (moves roll off after 6 placements)."
    )
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Game mode")
        .addChoices(
          { name: "vs Computer", value: "comp" },
          { name: "PvP (two players)", value: "pvp" }
        )
        .setRequired(true)
    )
    .addUserOption((o) =>
      o.setName("opponent").setDescription("Opponent user (required for PvP)")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .setDMPermission(true),

  async execute(interaction) {
    // DM and Guild both supported
    const mode = interaction.options.getString("mode", true);
    const opponentUser = interaction.options.getUser("opponent");
    if (mode === "pvp" && !opponentUser) {
      return safeReply(interaction, {
        content: "Please provide an opponent for PvP mode.",
      });
    }

    // Initial state
    const isComp = mode === "comp";
    const you = interaction.user.id;
    const opp = isComp ? "bot" : opponentUser.id;

    // Random marks
    const marks = Math.random() < 0.5 ? { X: you, O: opp } : { X: opp, O: you };
    const board = [
      [" ", " ", " "],
      [" ", " ", " "],
      [" ", " ", " "],
    ];

    const state = {
      mode,
      createdBy: you,
      players: { X: marks.X, O: marks.O }, // 'bot' if comp & assigned
      turn: "X",
      board,
      moves: [], // [{i,j,mark}]
      createdAt: Date.now(),
      lastMoveAt: Date.now(),
      // Settings
      maxTrail: 6, // keep last 6 marks, older cells open up
    };

    const open = `Let's play Infinite Tic-Tac-Toe!
You are <@${you}>. ${isComp ? "I am your opponent." : `Opponent: <@${opp}>.`}
**${renderAssigned(state)}** begins.`;

    // Build initial components (IDs will be refreshed by handler each move)
    const components = buildBoardComponents(interaction, state);

    await interaction.reply({ content: open, components });
    const msg = await interaction.fetchReply();

    // Persist game row
    try {
      await query(
        `INSERT INTO persistent_components (
           message_id, channel_id, guild_id,
           component_type, component_key, component_data,
           expires_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
         ON CONFLICT (message_id, component_key)
         DO UPDATE SET component_data = EXCLUDED.component_data,
                       expires_at   = EXCLUDED.expires_at`,
        [
          msg.id,
          msg.channelId,
          interaction.guildId || null,
          COMPONENT_TYPE,
          COMPONENT_KEY,
          JSON.stringify(state),
          // 2 hours from now; handlers bump this on interaction
          new Date(Date.now() + 2 * 60 * 60 * 1000),
        ]
      );
    } catch (err) {
      log.error({ err }, "Failed to persist new TicTacToe game");
    }

    // If bot is X and it’s comp mode, immediately make the first move
    if (isComp && state.players.X === "bot") {
      // emulate a move by calling same logic used in the handler:
      await botMoveAndUpdate(interaction.client, msg, state);
    }
  },
};

// ===== Helpers (shared between command and components) =====

export function renderAssigned(state) {
  const who = (mark) =>
    state.players[mark] === "bot" ? "Bot" : `<@${state.players[mark]}>`;
  return `**X:** ${who("X")} | **O:** ${who("O")}`;
}

export function buildBoardComponents(interaction, state) {
  // Each re-render must create fresh custom IDs to satisfy anti-replay
  // We intentionally remove the user pin so both authorized players can press
  const rows = [];

  for (let i = 0; i < 3; i++) {
    const row = new ActionRowBuilder();
    for (let j = 0; j < 3; j++) {
      const cell = state.board[i][j];
      const disabled = cell !== " ";
      const style =
        cell === "X"
          ? ButtonStyle.Danger
          : cell === "O"
          ? ButtonStyle.Success
          : ButtonStyle.Secondary;

      const cid = makeTttId(interaction, "move", { i, j });

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(cid)
          .setLabel(cell === " " ? "\u200b" : cell)
          .setStyle(style)
          .setDisabled(disabled)
      );
    }
    rows.push(row);
  }

  // Resign row
  const resignId = makeTttId(interaction, "resign", {});
  const resignRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(resignId.replace(/:eyJ1Ijoi[^:]+:/, ":{}/:"))
      .setEmoji("🚩")
      .setCustomId(resignId)
      .setStyle(ButtonStyle.Primary)
  );

  // Highlight the “next to expire” (oldest) move when we’re exactly on trail size
  if (state.moves.length === state.maxTrail) {
    const { i, j } = state.moves[0];
    const idx = i * 3 + j;
    // rows[?] index mapping: row i contains 3 buttons; adjust style to blurple
    rows[i].components[j].setStyle(ButtonStyle.Primary);
  }

  return [...rows, resignRow];
}

// Build a **compact** custom_id:
// keep only expiry (e), nonce (n) and coordinates in d = {i,j}
// drop u/g/c/m to stay far under 100 chars and allow both players to click.
function makeTttId(interaction, action, coords, ttlSec = 3600) {
  const id = new SecureCustomId("ttt", action, "v1")
    .setContext(interaction) // creates u,g,c,m,e,n
    .setData(coords) // put {i,j} (or {} for resign)
    .setTTL(ttlSec);
  // strip everything we don't need to keep IDs tiny and multi-user
  delete id.data.u; // allow both participants
  delete id.data.g; // shrink
  delete id.data.c; // shrink
  delete id.data.m; // shrink (nonce already prevents replay)
  return id.build();
}

// Save + fetch
export async function loadGame(messageId) {
  const {
    rows: [row],
  } = await query(
    `SELECT component_data FROM persistent_components
     WHERE message_id = $1 AND component_key = $2`,
    [messageId, COMPONENT_KEY]
  );
  if (!row) return null;
  return row.component_data;
}

export async function saveGame(
  messageId,
  guildId,
  channelId,
  state,
  ttlMs = 2 * 60 * 60 * 1000
) {
  await query(
    `INSERT INTO persistent_components (
       message_id, channel_id, guild_id,
       component_type, component_key, component_data,
       expires_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (message_id, component_key)
     DO UPDATE SET component_data = EXCLUDED.component_data,
                   expires_at   = EXCLUDED.expires_at`,
    [
      messageId,
      channelId,
      guildId || null,
      COMPONENT_TYPE,
      COMPONENT_KEY,
      JSON.stringify(state),
      new Date(Date.now() + ttlMs),
    ]
  );
}

export function isPlayerAuthorized(state, userId) {
  if (state.mode === "comp") {
    // Only the human is allowed
    const human = state.players.X === "bot" ? state.players.O : state.players.X;
    return userId === human;
  }
  return userId === state.players.X || userId === state.players.O;
}

export function markOf(userId, state) {
  if (state.players.X === userId) return "X";
  if (state.players.O === userId) return "O";
  return null;
}
