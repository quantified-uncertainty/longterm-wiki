/**
 * Prediction Market Fetcher
 *
 * Fetches latest probability snapshots from prediction market platform APIs
 * for questions already stored in the prediction_market_questions table.
 *
 * Supported platforms:
 * - Metaculus: Public API v2 (https://www.metaculus.com/api2/questions/{id}/)
 * - Polymarket / Manifold: deferred to future sessions
 *
 * Usage:
 *   crux tb markets-fetch                 # Fetch all active questions
 *   crux tb markets-fetch anthropic       # Only questions for Anthropic
 *   crux tb markets-fetch --source=metaculus  # Only Metaculus questions
 *   crux tb markets-fetch --dry-run       # Preview without writing
 */

import type { CommandResult } from "../lib/command-types.ts";
import { apiRequest } from "../lib/wiki-server/client.ts";
import { generateId } from "../lib/grant-import/id.ts";

interface FetchOptions {
  platform?: string;
  entitySlug?: string;
  dryRun?: boolean;
}

interface PredictionQuestion {
  id: string;
  platform: string;
  platformQuestionId: string;
  questionText: string;
  entityId: string | null;
  isResolved: boolean;
}

interface MetaculusApiResponse {
  id: number;
  title: string;
  url: string;
  community_prediction?: {
    full?: { q2?: number };
    q1?: number;
    q2?: number;
    q3?: number;
  };
  question?: {
    community_prediction?: {
      full?: { q2?: number };
      q1?: number;
      q2?: number;
      q3?: number;
    };
  };
  number_of_predictions?: number;
  forecasts_count?: number;
  resolution?: number | null;
  active_state?: string;
}

type SnapshotData = {
  probability: number | null;
  probabilityLow: number | null;
  probabilityHigh: number | null;
  numForecasters: number | null;
};

async function fetchMetaculusQuestion(
  platformQuestionId: string
): Promise<SnapshotData | null> {
  const token = process.env.METACULUS_API_TOKEN;
  const url = `https://www.metaculus.com/api2/questions/${platformQuestionId}/`;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "longtermwiki/1.0",
    };
    if (token) {
      headers.Authorization = `Token ${token}`;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      if (response.status === 403 && !token) {
        // Only warn once about missing token
        return null;
      }
      console.warn(
        `  Metaculus API returned ${response.status} for question ${platformQuestionId}`
      );
      return null;
    }

    const data = (await response.json()) as MetaculusApiResponse;

    const cp =
      data.community_prediction ?? data.question?.community_prediction;
    const median = cp?.full?.q2 ?? cp?.q2 ?? null;
    const q1 = cp?.q1 ?? null;
    const q3 = cp?.q3 ?? null;
    const numForecasters =
      data.number_of_predictions ?? data.forecasts_count ?? null;

    return {
      probability: median,
      probabilityLow: q1,
      probabilityHigh: q3,
      numForecasters,
    };
  } catch (err) {
    console.warn(
      `  Failed to fetch Metaculus question ${platformQuestionId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

interface ManifoldMarketResponse {
  id: string;
  probability?: number;
  totalLiquidity?: number;
  volume?: number;
  uniqueBettorCount?: number;
}

async function fetchManifoldQuestion(
  platformQuestionId: string
): Promise<SnapshotData | null> {
  // Manifold question IDs from discovery are in "user/slug" format
  // The API uses the slug directly
  const url = `https://api.manifold.markets/v0/slug/${encodeURIComponent(platformQuestionId)}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(
        `  Manifold API returned ${response.status} for ${platformQuestionId}`
      );
      return null;
    }

    const data = (await response.json()) as ManifoldMarketResponse;

    return {
      probability: data.probability ?? null,
      probabilityLow: null,
      probabilityHigh: null,
      numForecasters: data.uniqueBettorCount ?? null,
    };
  } catch (err) {
    console.warn(
      `  Failed to fetch Manifold market ${platformQuestionId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

export async function fetchMarketSnapshots(
  options: FetchOptions
): Promise<CommandResult> {
  const { platform, entitySlug, dryRun = false } = options;

  // Fetch active questions from wiki-server
  let questionsPath = "/api/prediction-markets/questions?isResolved=false&limit=500";
  if (entitySlug) {
    questionsPath = `/api/prediction-markets/questions/by-entity/${encodeURIComponent(entitySlug)}?isResolved=false&limit=500`;
  }

  const questionsResult = await apiRequest<{
    questions: PredictionQuestion[];
    total: number;
  }>("GET", questionsPath);

  if (!questionsResult.ok) {
    return {
      exitCode: 1,
      output: `Failed to fetch questions: ${questionsResult.message}`,
    };
  }

  let questions = questionsResult.data.questions;
  if (platform) {
    questions = questions.filter((q) => q.platform === platform);
  }

  if (questions.length === 0) {
    return {
      exitCode: 0,
      output: "No active prediction market questions found to fetch.",
    };
  }

  console.log(`Found ${questions.length} active questions to fetch.`);

  const today = new Date().toISOString().slice(0, 10);
  const snapshots: Array<{
    id: string;
    questionId: string;
    date: string;
    probability: number | null;
    probabilityLow: number | null;
    probabilityHigh: number | null;
    numForecasters: number | null;
    volume: number | null;
    openInterest: number | null;
    communityPrediction: number | null;
    source: string | null;
  }> = [];

  let fetchedCount = 0;
  let skippedCount = 0;
  let metaculusAuthWarned = false;

  const supportedPlatforms = new Set(["metaculus", "manifold"]);
  const supported = questions.filter((q) => supportedPlatforms.has(q.platform));
  const unsupported = questions.length - supported.length;

  if (unsupported > 0) {
    console.log(`  (${unsupported} questions on unsupported platforms skipped)`);
  }

  for (let i = 0; i < supported.length; i++) {
    const q = supported[i];
    let result: SnapshotData | null = null;
    let sourceUrl: string | null = null;

    if (q.platform === "metaculus") {
      if (!process.env.METACULUS_API_TOKEN && !metaculusAuthWarned) {
        console.warn("  ⚠ METACULUS_API_TOKEN not set — Metaculus questions will be skipped (API requires auth)");
        metaculusAuthWarned = true;
      }
      if (!process.env.METACULUS_API_TOKEN) {
        skippedCount++;
        continue;
      }
      // Rate-limit: 1 request per 1.5s to avoid 429s
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      result = await fetchMetaculusQuestion(q.platformQuestionId);
      sourceUrl = `https://www.metaculus.com/questions/${q.platformQuestionId}/`;
    } else if (q.platform === "manifold") {
      // Rate-limit: 1 request per 0.5s
      if (i > 0) await new Promise((r) => setTimeout(r, 500));
      result = await fetchManifoldQuestion(q.platformQuestionId);
      sourceUrl = `https://manifold.markets/${q.platformQuestionId}`;
    }

    if (result && result.probability != null) {
      snapshots.push({
        id: generateId(`pms|${q.id}|${today}`),
        questionId: q.id,
        date: today,
        probability: result.probability,
        probabilityLow: result.probabilityLow,
        probabilityHigh: result.probabilityHigh,
        numForecasters: result.numForecasters,
        volume: null,
        openInterest: null,
        communityPrediction: result.probability,
        source: sourceUrl,
      });
      fetchedCount++;
      console.log(
        `  ✓ [${q.platform}] ${q.platformQuestionId}: ${(result.probability * 100).toFixed(1)}% (${result.numForecasters ?? "?"} forecasters)`
      );
    } else {
      skippedCount++;
    }
  }

  if (snapshots.length === 0) {
    return {
      exitCode: 0,
      output: `Fetched 0 snapshots (${skippedCount} skipped). No data to sync.`,
    };
  }

  if (dryRun) {
    return {
      exitCode: 0,
      output: `[DRY RUN] Would sync ${snapshots.length} snapshots.\n${snapshots.map((s) => `  ${s.questionId} → ${s.probability}`).join("\n")}`,
    };
  }

  // Sync snapshots to wiki-server
  const syncResult = await apiRequest<{ upserted: number }>(
    "POST",
    "/api/prediction-markets/snapshots/sync",
    { items: snapshots }
  );

  if (!syncResult.ok) {
    return {
      exitCode: 1,
      output: `Failed to sync snapshots: ${syncResult.message}`,
    };
  }

  return {
    exitCode: 0,
    output: `Fetched ${fetchedCount} snapshots, skipped ${skippedCount}. Synced ${syncResult.data.upserted} to DB.`,
  };
}
