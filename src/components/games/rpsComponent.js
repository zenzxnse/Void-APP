// src/components/games/rps.js
import { ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { colors, randomize } from '../../graphics/colors.js';

export const customIds = ['rps_rock', 'rps_paper', 'rps_scissors'];
export const defer = 'update';
export const available_to_caller_only = true;

// Buttons (unchanged GUI)
export const rpsButtons = [
  new ButtonBuilder().setCustomId('rps_rock').setLabel('Rock').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('rps_paper').setLabel('Paper').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('rps_scissors').setLabel('Scissors').setStyle(ButtonStyle.Primary),
];

// 0: Rock, 1: Paper, 2: Scissors
const idxFromToken = { rock: 0, paper: 1, scissors: 2 };
const labelFromIdx = ['Rock', 'Paper', 'Scissors'];

// Flavor text
const WIN_PHRASES  = ['Clean hit!', 'Too easy 😎', 'GG!', 'Outplayed.', 'Nice one!'];
const LOSE_PHRASES = ['Ouch…', 'The bot got lucky 😤', 'GG, try again.', 'RIP.', 'Next time!'];
const TIE_PHRASES  = ['Stalemate.', 'Mind games…', 'Run it back?', 'So close.', 'Even match.'];

// Why a result happened
const REASONS = {
  '0-2': 'Rock crushes Scissors',
  '1-0': 'Paper wraps Rock',
  '2-1': 'Scissors cut Paper',
};
function matchupReason(a, b) {
  if (a === b) return 'Both chose the same move';
  return REASONS[`${a}-${b}`] || REASONS[`${b}-${a}`];
}

function outcome(userIdx, botIdx) {
  const r = (userIdx - botIdx + 3) % 3;
  return r === 0 ? 'tie' : r === 1 ? 'win' : 'lose';
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

export async function execute(interaction) {
  const token = interaction.customId.split('_')[1]; // 'rock' | 'paper' | 'scissors'
  const userIdx = idxFromToken[token];
  if (userIdx == null) {
    return interaction.editReply({ content: 'Unknown choice.', components: [] });
  }

  const botIdx = Math.floor(Math.random() * 3);
  const userMove = labelFromIdx[userIdx];
  const botMove  = labelFromIdx[botIdx];

  const who = outcome(userIdx, botIdx);
  const reason = matchupReason(userIdx, botIdx);
  const phrase = who === 'win' ? pick(WIN_PHRASES) : who === 'lose' ? pick(LOSE_PHRASES) : pick(TIE_PHRASES);

  // Mentions for the "feed" line
  const userMention = `<@${interaction.user.id}>`;
  const botMention  = `<@${interaction.client.user.id}>`;

  // Status line & emoji
  const statusEmoji = who === 'win' ? '🏆' : who === 'lose' ? '💀' : '🤝';
  const feed =
    who === 'win'
      ? `${statusEmoji} ${userMention} **beat** ${botMention} — ${userMove} vs ${botMove} • ${reason}. **${phrase}**`
      : who === 'lose'
      ? `${statusEmoji} ${userMention} **lost to** ${botMention} — ${userMove} vs ${botMove} • ${reason}. **${phrase}**`
      : `${statusEmoji} ${userMention} **tied with** ${botMention} — ${userMove} vs ${botMove}. **${phrase}**`;

  const embed = new EmbedBuilder()
    .setColor(randomize(colors))
    .setTitle('Rock Paper Scissors — Result')
    .setDescription(
      `You chose: **${userMove}**\n` +
      `Bot chose: **${botMove}**\n\n` +
      `**Result:** ${who === 'win' ? 'You win!' : who === 'lose' ? 'You lose!' : "It's a tie!"}\n` +
      `*${reason}*`
    )
    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
    .setThumbnail(interaction.user.displayAvatarURL())
    .setTimestamp();

  // Update original message: show feed (with mentions) + embed, remove buttons
  await interaction.editReply({
    content: feed,
    embeds: [embed],
    components: [],
    // Only allow pings for the two users we mention (caller + bot)
    allowedMentions: { parse: [], users: [interaction.user.id, interaction.client.user.id], roles: [], repliedUser: false },
  });
}
