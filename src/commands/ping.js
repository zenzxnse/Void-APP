import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {colors, randomize} from '../graphics/colors.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Ping!'),
    async execute(interaction, client) {
        const sent = await interaction.reply({
            content: 'Pinging...',
            fetchReply: true
        });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        const apiLatency = Math.round(client.ws.ping);
        const emb = new EmbedBuilder()
            .setColor(randomize(colors))
            .setTitle('Pong!')
            .setDescription(`Latency: ${latency}ms\nAPI Latency: ${apiLatency}ms`)
            .setTimestamp()
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() });
        await interaction.editReply({ content: '', embeds: [emb] });
    },
};
