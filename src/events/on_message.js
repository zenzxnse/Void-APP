import { Events } from "discord.js";
import { fetchMessage } from "../utils/fetchMessage.js";
import config from "../core/config.js";

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        if (message.author.bot) return;

        if (!config.AI_ALLOWED_LIST.includes(message.author.id)) {
            return;
        }


    }
}