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

const RATE_LIMIT_MS = 30_000; // 30 second per-user cooldown
const MAX_CONCURRENT_REQUESTS = 3; // global concurrency cap

// Map of userId -> last request timestamp
const userLastRequest = new Map<string, number>();
// Count of currently active requests
let activeRequests = 0;

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

  // Per-user rate limiting: enforce 30-second cooldown
  const now = Date.now();
  const lastRequest = userLastRequest.get(message.author.id);
  if (lastRequest !== undefined) {
    const elapsed = now - lastRequest;
    if (elapsed < RATE_LIMIT_MS) {
      const remaining = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
      await message.reply(
        `Please wait ${remaining} more second${remaining === 1 ? "" : "s"} before asking another question.`
      );
      return;
    }
  }

  // Global concurrency cap
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await message.reply(
      "The bot is currently busy handling other requests. Please try again in a moment."
    );
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Question from ${message.author.tag}: ${question}`);
  console.log("=".repeat(60));

  // Record this user's request time and increment active count
  userLastRequest.set(message.author.id, now);
  activeRequests++;

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
  } finally {
    activeRequests--;
  }
});

client.login(process.env.DISCORD_TOKEN);
