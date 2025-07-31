import { Events } from "discord.js";

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`[INFO] ${client.user.tag} is online!`);
        client.user.setActivity("Void Bot", { type: "WATCHING" });
    },
}