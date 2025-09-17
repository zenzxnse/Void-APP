import { SlashCommandBuilder, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import crypto from 'node:crypto';

export default {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Play Rock Paper Scissors!')
    .addSubcommand(s => s.setName('solo').setDescription('playing against the computer'))
    .addSubcommand(s => s.setName('duel')
      .setDescription('playing against other players')
      .addUserOption(o => o.setName('opponent').setDescription('Select your opponent').setRequired(true))
    ),

  async execute(interaction) {
    
  }
};
