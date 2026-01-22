import { emojies } from "../graphics/colors.js";
import { createLogger } from "../core/logger.js";
import { MessageFlags } from "discord.js";

const logger = createLogger({ mod: "test_components" });


export function registerTestComponents(router) {
    router.button("button_1:run", {
        callerOnly: true,
        defer: 'update',
        
        async execute(interaction, context) {
            logger.info({ 
                userId: interaction.user.id, 
                customId: interaction.customId,
                length: interaction.customId.length 
            }, 'Test button clicked');
            // send a message to the user
            await interaction.followUp({
                content: `${emojies.success} **Test Passed.**\nID received and parsed successfully.`,
                flags: MessageFlags.Ephemeral
            });
        }
    });
    router.button("button_2:run", {
        callerOnly: true,
        defer: 'update',
        
        async execute(interaction, context) {
            logger.info({ 
                userId: interaction.user.id, 
                customId: interaction.customId
            }, 'Test button 2 clicked');
            await interaction.followUp({
                content: `${emojies.success} **Test Button 2 Passed.**`,
                flags: MessageFlags.Ephemeral
            });
        }
    });
}