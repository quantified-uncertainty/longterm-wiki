import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { runQuery } from "./query.js";
import {
  QueryLog,
  logQuery,
  calculateCost,
  formatLogSummary,
  ensureLogsDir,
} from "./logger.js";

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in environment");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Bot is ready! Logged in as ${c.user.tag}`);
  ensureLogsDir();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only respond when @mentioned
  if (!client.user || !message.mentions.has(client.user)) return;

  // Extract the question (remove the @mention)
  const question = message.content.replace(/<@!?\d+>/g, "").trim();

  if (!question) {
    await message.reply(
      "Please ask a question! Example: @bot What are the main AI risk categories?"
    );
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Question from ${message.author.tag}: ${question}`);
  console.log("=".repeat(60));

  await message.channel.sendTyping();

  const startTime = Date.now();

  try {
    console.log("Starting Claude Agent SDK query (60s timeout)...");
    const queryResult = await runQuery(question);
    const durationMs = Date.now() - startTime;

    const estimatedCostUsd = calculateCost(
      queryResult.inputTokens,
      queryResult.outputTokens,
      queryResult.model
    );

    const queryLog: QueryLog = {
      timestamp: new Date().toISOString(),
      question,
      userId: message.author.id,
      userName: message.author.tag,
      responseLength: queryResult.result.length,
      durationMs,
      toolCalls: queryResult.toolCalls,
      inputTokens: queryResult.inputTokens,
      outputTokens: queryResult.outputTokens,
      cacheReadTokens: queryResult.cacheReadTokens,
      cacheCreationTokens: queryResult.cacheCreationTokens,
      model: queryResult.model,
      estimatedCostUsd,
      success: true,
    };

    logQuery(queryLog);
    console.log("\n" + formatLogSummary(queryLog));

    let result = queryResult.result;
    if (result.length > 1900) {
      result = result.slice(0, 1900) + "\n\n... (truncated)";
    }

    await message.reply(
      result || "I couldn't find an answer to that question."
    );
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logQuery({
      timestamp: new Date().toISOString(),
      question,
      userId: message.author.id,
      userName: message.author.tag,
      responseLength: 0,
      durationMs,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      success: false,
      error: errorMessage,
    });

    console.error("Error querying Claude:", error);
    await message.reply(`Sorry, I encountered an error: ${errorMessage}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
