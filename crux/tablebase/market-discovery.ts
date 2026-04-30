/**
 * Prediction Market Discovery Agent
 *
 * Uses an LLM agent with web search to discover prediction market questions
 * relevant to a given entity (e.g., Anthropic, OpenAI).
 *
 * Discovered questions are synced to the prediction_market_questions table
 * via the wiki-server API.
 *
 * Usage:
 *   crux tb markets-discover anthropic
 *   crux tb markets-discover openai --dry-run
 */

import type { CommandResult } from "../lib/command-types.ts";
import { createLlmClient, runLlmAgent, MODELS } from "../lib/llm.ts";
import { CostTracker } from "../lib/cost-tracker.ts";
import { apiRequest } from "../lib/wiki-server/client.ts";
import { generateId } from "../lib/grant-import/id.ts";

interface DiscoverOptions {
  dryRun?: boolean;
  model?: string;
}

interface DiscoveredQuestion {
  platform: string;
  platformQuestionId: string;
  questionText: string;
  questionUrl: string;
  resolutionDate?: string;
  questionType: string;
  category?: string;
  currentProbability?: number;
}

const SYSTEM_PROMPT = `You are a prediction market research agent. Your task is to find prediction market questions on Metaculus, Polymarket, and Manifold Markets that are relevant to a specific entity (company, organization, or person).

You have access to web search. Use it to find questions on these platforms.

For each platform, search for questions using patterns like:
- Metaculus: Search "site:metaculus.com {entity_name}" or browse metaculus.com/questions/ for relevant topics
- Polymarket: Search "site:polymarket.com {entity_name}"
- Manifold: Search "site:manifold.markets {entity_name}"

When you find relevant questions, call the submit_questions tool with the discovered questions.

Focus on questions about:
- Company valuation and IPO timing
- AI safety and alignment commitments
- Product launches and capability milestones
- Regulatory actions affecting the entity
- Leadership changes
- Revenue and market share

Only include questions that are currently active (not yet resolved) and clearly relevant to the entity. Prefer questions with many forecasters over obscure ones.`;

function buildUserPrompt(
  entityName: string,
  entitySlug: string,
  stableId: string | null
): string {
  return `Find prediction market questions on Metaculus, Polymarket, and Manifold Markets that are relevant to "${entityName}".

Entity details:
- Name: ${entityName}
- Slug: ${entitySlug}
${stableId ? `- StableId: ${stableId}` : ""}

Search each platform for questions about this entity. Include questions about the entity's valuation, products, safety practices, regulatory environment, leadership, and competitive position.

For each question, extract:
1. The platform (metaculus, polymarket, or manifold)
2. The platform's question ID (from the URL)
3. The full question text
4. The question URL
5. The resolution date (if available)
6. The question type (binary, numeric, or multiple_choice)
7. A category (valuation, ipo, safety, timeline, regulation, capability, leadership, revenue, other)
8. The current community probability (if visible)

Submit all discovered questions using the submit_questions tool.`;
}

export async function discoverMarkets(
  entitySlug: string,
  options: DiscoverOptions
): Promise<CommandResult> {
  const { dryRun = false, model = MODELS.sonnet } = options;

  // Resolve entity via search API
  let entityName = entitySlug;
  let stableId: string | null = null;

  const searchResult = await apiRequest<{
    results: Array<{ id: string; stableId: string; title: string; entityType: string }>;
  }>("GET", `/api/entities/search?q=${encodeURIComponent(entitySlug)}&limit=5`);

  // Detect explicit identifiers — sid_-prefixed stableIds and dash/numeric slugs.
  // For these, we MUST find an exact match. Otherwise the entity-search title-prefix
  // fallback misattributes markets (e.g. sid_n7K9yVNCtg → "Sid Black", fisa-702 → "Tim Fist").
  const looksLikeId = /^sid_[A-Za-z0-9]+$/.test(entitySlug) || /-/.test(entitySlug);

  if (searchResult.ok && searchResult.data.results.length > 0) {
    const exact = searchResult.data.results.find(
      (r) => r.id === entitySlug || r.stableId === entitySlug
    );
    if (exact) {
      entityName = exact.title;
      stableId = exact.stableId;
    } else if (looksLikeId) {
      return {
        output: `Could not resolve "${entitySlug}" to an exact entity.id or stableId. ` +
          `Top fuzzy result was "${searchResult.data.results[0].title}" — refusing to misattribute. ` +
          `Pass an exact entity slug or use --by-name "<title>" to override.`,
        exitCode: 1,
      };
    } else {
      // Free-form name — accept the top fuzzy match.
      const match = searchResult.data.results[0];
      entityName = match.title;
      stableId = match.stableId;
    }
  } else if (looksLikeId) {
    return {
      output: `Could not resolve "${entitySlug}" to a known entity.`,
      exitCode: 1,
    };
  } else {
    console.warn(
      `Could not resolve entity "${entitySlug}", using as display name.`
    );
  }

  console.log(
    `[market-discovery] Discovering markets for "${entityName}"${dryRun ? " [DRY RUN]" : ""}`
  );

  const client = createLlmClient();
  const tracker = new CostTracker();
  const startTime = Date.now();

  const allDiscovered: DiscoveredQuestion[] = [];

  const tools = [
    {
      name: "submit_questions" as const,
      description:
        "Submit discovered prediction market questions. Call this with all questions you find.",
      input_schema: {
        type: "object" as const,
        properties: {
          questions: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                platform: {
                  type: "string" as const,
                  enum: ["metaculus", "polymarket", "manifold"],
                  description: "Platform name",
                },
                platformQuestionId: {
                  type: "string" as const,
                  description:
                    "Platform's native question ID (e.g., Metaculus question number from URL)",
                },
                questionText: {
                  type: "string" as const,
                  description: "Full question text",
                },
                questionUrl: {
                  type: "string" as const,
                  description: "Full URL to the question",
                },
                resolutionDate: {
                  type: "string" as const,
                  description: "Expected resolution date (YYYY-MM-DD), if known",
                },
                questionType: {
                  type: "string" as const,
                  enum: ["binary", "numeric", "multiple_choice"],
                  description: "Question type",
                },
                category: {
                  type: "string" as const,
                  enum: [
                    "valuation",
                    "ipo",
                    "safety",
                    "timeline",
                    "regulation",
                    "capability",
                    "leadership",
                    "revenue",
                    "other",
                  ],
                  description: "Topic category",
                },
                currentProbability: {
                  type: "number" as const,
                  description:
                    "Current community probability (0-1), if visible",
                },
              },
              required: [
                "platform",
                "platformQuestionId",
                "questionText",
                "questionUrl",
                "questionType",
              ],
            },
          },
        },
        required: ["questions"],
      },
    },
  ];

  const toolHandlers: Record<
    string,
    (input: Record<string, unknown>) => Promise<string>
  > = {
    submit_questions: async (input) => {
      const rawQuestions = input.questions;
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        return "No questions provided.";
      }

      // Validate each question at runtime — LLM output may not conform
      const valid: DiscoveredQuestion[] = [];
      for (const q of rawQuestions) {
        if (
          typeof q === "object" &&
          q !== null &&
          typeof q.platform === "string" &&
          typeof q.platformQuestionId === "string" &&
          typeof q.questionText === "string" &&
          typeof q.questionUrl === "string" &&
          typeof q.questionType === "string"
        ) {
          valid.push(q as DiscoveredQuestion);
        } else {
          console.warn(
            `[market-discovery] Skipping malformed question: ${JSON.stringify(q).slice(0, 100)}`
          );
        }
      }

      if (valid.length === 0) {
        return "All questions were malformed. Please ensure each has platform, platformQuestionId, questionText, questionUrl, and questionType.";
      }

      allDiscovered.push(...valid);

      return `Received ${valid.length} valid questions (${rawQuestions.length - valid.length} skipped). Continue searching other platforms if you haven't yet.`;
    },
  };

  const serverTools = [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 20 }];

  const userPrompt = buildUserPrompt(entityName, entitySlug, stableId);

  await runLlmAgent(client, userPrompt, {
    model,
    maxTokens: 8000,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    serverTools,
    toolHandlers,
    maxToolTurns: 30,
    retryLabel: "market-discovery",
    heartbeatPhase: "market-discovery",
    costTracker: tracker,
    onToolResult: (toolName, result) => {
      console.log(
        `[market-discovery]   tool: ${toolName} → ${result.slice(0, 120)}`
      );
    },
  });

  const durationMs = Date.now() - startTime;
  console.log(
    `[market-discovery] Agent completed: ${allDiscovered.length} questions found, ${Math.round(durationMs / 1000)}s, $${tracker.totalCost.toFixed(4)}`
  );

  if (allDiscovered.length === 0) {
    return {
      exitCode: 0,
      output: `No prediction market questions found for "${entityName}".`,
    };
  }

  // Deduplicate by platform+platformQuestionId
  const seen = new Set<string>();
  const unique = allDiscovered.filter((q) => {
    const key = `${q.platform}:${q.platformQuestionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(
    `[market-discovery] ${unique.length} unique questions (${allDiscovered.length - unique.length} duplicates removed)`
  );

  if (dryRun) {
    const summary = unique
      .map(
        (q) =>
          `  [${q.platform}] ${q.questionText.slice(0, 80)}... (${q.category ?? "uncategorized"})`
      )
      .join("\n");
    return {
      exitCode: 0,
      output: `[DRY RUN] Would sync ${unique.length} questions:\n${summary}`,
    };
  }

  // Convert to sync format
  const items = unique.map((q) => ({
    id: generateId(`pmq|${q.platform}|${q.platformQuestionId}`),
    platform: q.platform,
    platformQuestionId: q.platformQuestionId,
    entityId: stableId,
    entityDisplayName: stableId ? null : entityName,
    questionText: q.questionText,
    questionUrl: q.questionUrl,
    resolutionDate: q.resolutionDate ?? null,
    questionType: q.questionType,
    category: q.category ?? null,
    isResolved: false,
    currentProbability: q.currentProbability ?? null,
    discoveryMethod: "llm_agent",
    source: q.questionUrl,
  }));

  const syncResult = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/prediction-markets/questions/sync",
    { items }
  );

  if (!syncResult.ok) {
    return {
      exitCode: 1,
      output: `Failed to sync questions: ${syncResult.message}`,
    };
  }

  return {
    exitCode: 0,
    output: `Discovered and synced ${syncResult.data.upserted} prediction market questions for "${entityName}" ($${tracker.totalCost.toFixed(4)}).`,
  };
}
