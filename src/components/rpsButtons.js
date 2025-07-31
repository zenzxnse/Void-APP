import { ButtonBuilder, ButtonStyle } from "discord.js";

export const rpsButtons = [
    new ButtonBuilder()
        .setCustomId("rock")
        .setLabel("Rock")
        .setStyle(ButtonStyle.Primary)
        .setCustomId('rps_rock'),
    new ButtonBuilder()
        .setCustomId("paper")
        .setLabel("Paper")
        .setStyle(ButtonStyle.Primary)
        .setCustomId('rps_paper'),
    new ButtonBuilder()
        .setCustomId("scissor")
        .setLabel("Scissors")
        .setStyle(ButtonStyle.Primary)
        .setCustomId('rps_scissor'),
]