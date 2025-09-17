// Infinite TicTacToe — Component Handlers (move / resign)
// Works with the V3 Component Router
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { SecureCustomId, makeId } from '../../components/ComponentRouter.js';
import { createLogger } from '../../core/logger.js';
import { query } from '../../core/db/index.js';
import {
  loadGame, saveGame, buildBoardComponents,
  isPlayerAuthorized, markOf, renderAssigned,
} from '../../commands/fun/infttt.js';

const log = createLogger({ mod: 'ttt' });

export function registerTicTacToeComponents(router) {
  // MOVE
  router.button('ttt:move', {
    name: 'ttt_move',
    defer: 'update',
    persistent: false, // we handle persistence manually
    cooldownMs: 400,   // debounce spam a bit
    dmPermission: true,
    guildOnly: false,

    async execute(interaction, ctx) {
      const parsed = SecureCustomId.parse(interaction.customId, interaction);
      if (!parsed) {
        return interaction.editReply({ content: 'This button expired. Start a new game.' });
      }

      const { messageId, i, j } = (parsed.data.custom || {});
      const msgId = messageId || interaction.message?.id;

      // Load game state
      let state = await loadGame(msgId);
      if (!state) {
        return interaction.editReply({ content: 'Game data missing or expired.' });
      }

      // Auth + turn checks
      if (!isPlayerAuthorized(state, interaction.user.id)) {
        return interaction.followUp({ content: 'This isn’t your game.', ephemeral: true });
      }

      // If PvP, enforce turn order
      const yourMark = markOf(interaction.user.id, state);
      if (state.mode === 'pvp' && yourMark !== state.turn) {
        return interaction.followUp({ content: `It’s **${state.turn}**’s turn.`, ephemeral: true });
      }

      // Validate move
      if (state.board[i][j] !== ' ') {
        return interaction.followUp({ content: 'That cell is already taken.', ephemeral: true });
      }

      // Apply player move
      state.board[i][j] = yourMark || state.turn;
      pushMove(state, i, j);

      // Check win/tie
      if (checkWin(state.board, state.board[i][j])) {
        await endGame(interaction, state, `${renderAssigned(state)}\n**${state.board[i][j]}** wins!`);
        return;
      }
      if (isBoardFull(state.board)) {
        await endGame(interaction, state, `${renderAssigned(state)}\nIt’s a tie!`);
        return;
      }

      // Switch turn
      state.turn = (state.board[i][j] === 'X') ? 'O' : 'X';

      // VS Computer: bot plays immediately if it’s bot’s turn
      if (state.mode === 'comp' && state.players[state.turn] === 'bot') {
        await botMoveAndUpdate(interaction.client, interaction.message, state, interaction);
        return; // botMoveAndUpdate will handle saving + render
      }

      // PvP: just re-render for the other player
      await saveGame(msgId, interaction.guildId, interaction.channelId, state);
      await interaction.editReply({
        content: `${renderAssigned(state)}\nTurn: **${state.turn}**`,
        components: rebuildWithFreshIds(interaction, state),
      });
    },
  });

  // RESIGN
  router.button('ttt:resign', {
    name: 'ttt_resign',
    defer: 'update',
    persistent: false,
    dmPermission: true,
    guildOnly: false,

    async execute(interaction, ctx) {
      const parsed = SecureCustomId.parse(interaction.customId, interaction);
      if (!parsed) {
        return interaction.editReply({ content: 'This button expired. Start a new game.' });
      }

      const { messageId } = (parsed.data.custom || {});
      const msgId = messageId || interaction.message?.id;

      const state = await loadGame(msgId);
      if (!state) {
        return interaction.editReply({ content: 'Game data missing or expired.' });
      }

      if (!isPlayerAuthorized(state, interaction.user.id)) {
        return interaction.followUp({ content: 'Only a participant can resign.', ephemeral: true });
      }

      const yourMark = markOf(interaction.user.id, state);
      const winner = yourMark === 'X' ? 'O' : 'X';

      await endGame(interaction, state, `${renderAssigned(state)}\n<@${interaction.user.id}> resigned. **${winner}** wins!`);
    },
  });
}

// ====== Local helpers for game logic/render ======

function rebuildWithFreshIds(interaction, state) {
  // Rebuild components with new custom IDs to satisfy anti-replay
  // We fake an interaction “context” so makeId encodes correct message/channel/guild
  const fakeIx = {
    ...interaction,
    message: interaction.message,
    id: interaction.id,
  };
  return buildBoardComponents(fakeIx, {
    ...state,
  });
}

export async function botMoveAndUpdate(client, message, state, ixForIds = null) {
  // Simple perfect bot (minimax). You can downgrade to heuristic if you want faster play.
  const botMark = state.turn; // whose turn is bot's
  let bestScore = -Infinity;
  let best = null;

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (state.board[i][j] === ' ') {
        state.board[i][j] = botMark;
        const sc = minimax(state.board, 0, false, botMark, opponent(botMark));
        state.board[i][j] = ' ';
        if (sc > bestScore) {
          bestScore = sc;
          best = { i, j };
        }
      }
    }
  }

  // Fallback if something went wrong
  if (!best) {
    const empty = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        if (state.board[i][j] === ' ') empty.push({ i, j });
    best = empty[Math.floor(Math.random() * empty.length)];
  }

  state.board[best.i][best.j] = botMark;
  pushMove(state, best.i, best.j);

  // Win/tie?
  const winNow = checkWin(state.board, botMark);
  const msgId = message.id;

  if (winNow) {
    await saveGame(msgId, message.guildId, message.channelId, state);
    await message.edit({
      content: `${renderAssigned(state)}\n**${botMark}** (Bot) wins!`,
      components: disabledBoard(state),
    });
    return;
  }
  if (isBoardFull(state.board)) {
    await saveGame(msgId, message.guildId, message.channelId, state);
    await message.edit({
      content: `${renderAssigned(state)}\nIt’s a tie!`,
      components: disabledBoard(state),
    });
    return;
  }

  // Switch turn back to human
  state.turn = opponent(botMark);
  await saveGame(msgId, message.guildId, message.channelId, state);

  // Re-render with fresh IDs
  const comp = rebuildAfterBot(message, state, ixForIds);
  await message.edit({
    content: `${renderAssigned(state)}\nTurn: **${state.turn}**`,
    components: comp,
  });
}

function rebuildAfterBot(message, state, ixForIds) {
  const fakeIx = ixForIds ?? {
    message,
    guildId: message.guildId || null,
    channelId: message.channelId,
    id: message.id,
    user: { id: state.players.X === 'bot' ? state.players.O : state.players.X },
  };
  return buildBoardComponents(fakeIx, state);
}

function disabledBoard(state) {
  // Produce a fully disabled board (game ended)
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = new ActionRowBuilder();
    for (let j = 0; j < 3; j++) {
      const cell = state.board[i][j];
      const style =
        cell === 'X' ? ButtonStyle.Danger :
        cell === 'O' ? ButtonStyle.Success :
        ButtonStyle.Secondary;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ttt:ended:${i}${j}`)
          .setLabel(cell === ' ' ? '\u200b' : cell)
          .setStyle(style)
          .setDisabled(true),
      );
    }
    rows.push(row);
  }
  const resignRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ttt:ended:resign')
      .setEmoji('🚩')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
  );
  return [...rows, resignRow];
}

async function endGame(interaction, state, messageText) {
  // Save final state and disable board
  await saveGame(interaction.message.id, interaction.guildId, interaction.channelId, state);
  await interaction.editReply({
    content: messageText,
    components: disabledBoard(state),
  });
}

function pushMove(state, i, j) {
  const mark = state.board[i][j];
  state.moves.push({ i, j, mark });
  // Infinite rolling rule: keep last 6 marks
  if (state.moves.length > state.maxTrail) {
    const old = state.moves.shift();
    // Clear oldest cell
    state.board[old.i][old.j] = ' ';
  }
  state.lastMoveAt = Date.now();
}

// ======= Game logic =======

function opponent(mark) {
  return mark === 'X' ? 'O' : 'X';
}

function checkWin(board, mark) {
  // rows/cols
  for (let i = 0; i < 3; i++) {
    if (board[i][0] === mark && board[i][1] === mark && board[i][2] === mark) return true;
    if (board[0][i] === mark && board[1][i] === mark && board[2][i] === mark) return true;
  }
  // diags
  if (board[0][0] === mark && board[1][1] === mark && board[2][2] === mark) return true;
  if (board[0][2] === mark && board[1][1] === mark && board[2][0] === mark) return true;
  return false;
}

function isBoardFull(board) {
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (board[i][j] === ' ') return false;
  return true;
}

// Basic minimax for 3x3
function minimax(board, depth, isMax, me, him) {
  if (checkWin(board, me)) return 10 - depth;
  if (checkWin(board, him)) return depth - 10;
  if (isBoardFull(board)) return 0;

  if (isMax) {
    let best = -Infinity;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (board[i][j] === ' ') {
          board[i][j] = me;
          best = Math.max(best, minimax(board, depth + 1, false, me, him));
          board[i][j] = ' ';
        }
      }
    }
    return best;
  } else {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (board[i][j] === ' ') {
          board[i][j] = him;
          best = Math.min(best, minimax(board, depth + 1, true, me, him));
          board[i][j] = ' ';
        }
      }
    }
    return best;
  }
}
