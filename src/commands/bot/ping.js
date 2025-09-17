import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {colors, randomize} from '../../graphics/colors.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check the bot\'s ping and latency.'),
    dmPermission: false,
    async execute(interaction) {
        const { client } = interaction;
        const ping = client.ws.ping;
        const latency = interaction.createdTimestamp - Date.now();

        const embed = new EmbedBuilder()
            .setColor(randomize(colors))
            .setTitle('Pong!')
            .addFields(
                { name: 'WebSocket Ping', value: `${ping} ms`, inline: true },
                { name: 'Latency', value: `${latency} ms`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
}
