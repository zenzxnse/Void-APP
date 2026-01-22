import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { emojies } from "../../graphics/colors.js";
import { safeReply } from "../../utils/moderation/mod.js";
import { makeId } from "../../components/ComponentRouter.js";
import { createLogger } from "../../core/logger.js";

const logger = createLogger({ mod: "components_test" });

export default {
    data: new SlashCommandBuilder()
        .setName("test")
        .setDescription("Sends a test message with buttons."),
    async execute(interaction) {
        try {
            try {
            const button1Id = makeId("button_1", "run", interaction, {}, 60);
            const button2Id = makeId("button_2", "run", interaction, {}, 60);

            logger.info({ userId: interaction.user.id }, 'Generating test buttons with IDs', { button1Id, button2Id });
            } catch (idError) {
                logger.error("Error generating button IDs:", idError);
                await safeReply(interaction, { content: `${emojies.error} There was an error generating button IDs.`, flags: MessageFlags.Ephemeral });
                throw idError;
            }

            const button1 = new ButtonBuilder()
                .setCustomId(button1Id)
                .setLabel("Test Button 1")
                .setStyle(ButtonStyle.Primary)
                // .setEmoji(emojies.success);
            const button2 = new ButtonBuilder()
                .setCustomId(button2Id)
                .setLabel("Test Button 2")
                .setStyle(ButtonStyle.Secondary)
                // .setEmoji(emojies.voidEye);
            const row = new ActionRowBuilder().addComponents(button1, button2);
            await safeReply(interaction, {
                content: "This is a test message with buttons.",
                components: [row],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            logger.error("Error executing test command:", error);
            await safeReply(interaction, { content: `${emojies.error} There was an error executing the test command.`, flags: MessageFlags.Ephemeral });
        }
    }
}   


