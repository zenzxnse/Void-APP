import { SlashCommandBuilder, ActionRowBuilder, EmbedBuilder, ButtonBuilder } from "discord.js";
import { rpsButtons } from "../components/rpsButtons.js";
import { colors, randomize } from "../graphics/colors.js";

export default {
    data: new SlashCommandBuilder().setName("rps").setDescription("Play Rock Paper Scissors!"),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(randomize(colors))
            .setTitle("Rock Paper Scissors")
            .setDescription("Choose your move!\n\nRock 🪨, Paper 🗞️, or Scissors ✂️?")
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(rpsButtons);

        await interaction.reply({ embeds: [embed], components: [row] });
    }
}