import Groq from "groq-sdk";
import 'dotenv/config';
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const groq = new Groq({
    apiKey: process.env.GROQ_KEY,
    baseUrl: 'https://api.groq.com/v1'
});

export async function fetchMessage(prompt) {
    try {
        const promptPath = new URL('./instruct.txt', import.meta.url);
        const systemPrompt = await readFile(promptPath, 'utf-8');

        const chatCompletion = await groq.chat.completions.create({
            "messages": [
                {
                    "role": "system",
                    "content": systemPrompt
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "model": "meta-llama/llama-4-scout-17b-16e-instruct",
            "stream": false,
        });
        return chatCompletion.choices[0]?.message?.content || '';
    } catch (error) {
        console.error("Error fetching response or reading prompt file:", error);
        return null;
    }
}

