import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { runQuery } from "./query.js";
import { runCodeQuery } from "./code-query.js";
import { registerCommands } from "./commands.js";
import {
  QueryLog,
  logQuery,
  calculateCost,
  ensureLogsDir,
} from "./logger.js";
import { logger } from "./log.js";
import {
  CLAUDE_CODE_OAUTH_TOKEN,
  WIKI_REPO_PATH,
  CODE_RATE_LIMIT_MS,
  CODE_MAX_CONCURRENT,
} from "./config.js";

// --- Startup validation ---

if (!process.env.DISCORD_TOKEN) {
  logger.fatal("Missing DISCORD_TOKEN in environment");
  process.exit(1);
}

if (!process.env.LONGTERMWIKI_SERVER_URL) {
  logger.fatal("Missing LONGTERMWIKI_SERVER_URL in environment");
  process.exit(1);
}

if (!process.env.LONGTERMWIKI_SERVER_API_KEY) {
  logger.fatal("Missing LONGTERMWIKI_SERVER_API_KEY in environment");
  process.exit(1);
}

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const hasOauthToken = !!CLAUDE_CODE_OAUTH_TOKEN;
const hasRepoPath = !!WIKI_REPO_PATH;

if (!hasApiKey && !hasOauthToken) {
  logger.fatal(
    "At least one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN must be set"
  );
  process.exit(1);
}

if (!hasApiKey) {
  logger.warn("ANTHROPIC_API_KEY not set — @mention queries disabled");
}

const askCommandEnabled = hasOauthToken && hasRepoPath;
if (hasOauthToken && !hasRepoPath) {
  logger.warn(
    "CLAUDE_CODE_OAUTH_TOKEN set but WIKI_REPO_PATH missing — /ask command disabled"
  );
}
if (!hasOauthToken) {
  logger.info("CLAUDE_CODE_OAUTH_TOKEN not set — /ask command disabled");
}

// --- Rate limiting: @mention ---

const RATE_LIMIT_MS = 30_000; // 30 second per-user cooldown
const MAX_CONCURRENT_REQUESTS = 3; // global concurrency cap

const userLastRequest = new Map<string, number>();
let activeRequests = 0;

// --- Rate limiting: /ask (separate state, stricter limits) ---

const askUserLastRequest = new Map<string, number>();
let askActiveRequests = 0;

// --- Discord client ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Bot is ready!");
  ensureLogsDir();

  if (askCommandEnabled) {
    await registerCommands(c.user.id, process.env.DISCORD_TOKEN!);
  }
});

// --- @mention handler (existing wiki Q&A) ---

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!client.user || !message.mentions.has(client.user)) return;

  const question = message.content.replace(/<@!?\d+>/g, "").trim();

  if (!question) {
    await message.reply(
      "Please ask a question! Example: @bot What are the main AI risk categories?"
    );
    return;
  }

  if (!hasApiKey) {
    await message.reply(
      "@mention queries are not available — ANTHROPIC_API_KEY is not configured. Try the /ask command instead."
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

  logger.info({ user: message.author.tag, question }, "Received question");

  // Record this user's request time and increment active count
  userLastRequest.set(message.author.id, now);
  activeRequests++;

  await message.channel.sendTyping();

  const startTime = Date.now();

  try {
    logger.info("Starting Claude Agent SDK query (60s timeout)...");
    const queryResult = await runQuery(question);
    const durationMs = Date.now() - startTime;

    const estimatedCostUsd = calculateCost(
      queryResult.inputTokens,
      queryResult.outputTokens,
      queryResult.model,
      queryResult.cacheReadTokens
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

    logger.error({ err: error }, "Error querying Claude");
    await message.reply(`Sorry, I encountered an error: ${errorMessage}`);
  } finally {
    activeRequests--;
  }
});

// --- /ask slash command handler ---

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "ask") return;

  if (!askCommandEnabled) {
    await interaction.reply({
      content:
        "The /ask command is not configured on this server. Use @mention for wiki Q&A instead.",
      ephemeral: true,
    });
    return;
  }

  const question = interaction.options.getString("question", true);
  const userId = interaction.user.id;

  // Per-user rate limiting (120s cooldown)
  const now = Date.now();
  const lastReq = askUserLastRequest.get(userId);
  if (lastReq !== undefined) {
    const elapsed = now - lastReq;
    if (elapsed < CODE_RATE_LIMIT_MS) {
      const remaining = Math.ceil((CODE_RATE_LIMIT_MS - elapsed) / 1000);
      await interaction.reply({
        content: `Please wait ${remaining} more second${remaining === 1 ? "" : "s"} before using /ask again.`,
        ephemeral: true,
      });
      return;
    }
  }

  // Global concurrency cap (1 concurrent /ask query)
  if (askActiveRequests >= CODE_MAX_CONCURRENT) {
    await interaction.reply({
      content:
        "An /ask query is already running. Please wait for it to finish.",
      ephemeral: true,
    });
    return;
  }

  // Defer reply within 3 seconds (Discord deadline)
  await interaction.deferReply();

  askUserLastRequest.set(userId, now);
  askActiveRequests++;

  logger.info(
    { user: interaction.user.tag, question },
    "/ask query received"
  );

  try {
    const result = await runCodeQuery(question);

    let response =
      result.result || "I couldn't find an answer to that question.";

    // Discord message limit: 2000 chars
    if (response.length > 1900) {
      response = response.slice(0, 1900) + "\n\n... (truncated)";
    }

    // Append stats as plain text
    const stats = `\n\n(${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls.length} tool calls)`;
    if (response.length + stats.length <= 2000) {
      response += stats;
    }

    await interaction.editReply(response);

    logQuery({
      timestamp: new Date().toISOString(),
      question: `/ask: ${question}`,
      userId,
      userName: interaction.user.tag,
      responseLength: result.result.length,
      durationMs: result.durationMs,
      toolCalls: result.toolCalls,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      model: result.model,
      success: true,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error({ err: error }, "/ask query error");

    logQuery({
      timestamp: new Date().toISOString(),
      question: `/ask: ${question}`,
      userId,
      userName: interaction.user.tag,
      responseLength: 0,
      durationMs: Date.now() - now,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      success: false,
      error: errorMessage,
    });

    try {
      await interaction.editReply(
        `Sorry, I encountered an error: ${errorMessage}`
      );
    } catch {
      // Interaction may have expired (15-minute window)
      logger.warn("Failed to edit reply — interaction may have expired");
    }
  } finally {
    askActiveRequests--;
  }
});

client.login(process.env.DISCORD_TOKEN);
