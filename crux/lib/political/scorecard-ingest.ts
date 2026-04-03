/**
 * Scorecard Ingestion Module
 *
 * Orchestrates fetching interest group scorecard data from external sources
 * and syncing it to the political_scores PG table via the wiki-server API.
 *
 * Each source implements the ScorecardSource interface. The orchestrator
 * handles batching (max 200 per sync call), deduplication via deterministic
 * IDs, and error reporting.
 */

import {
  apiRequest,
  getServerUrl,
  type ApiResult,
} from "../wiki-server/client.ts";
import { generateDeterministicId } from "./id-utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single score record ready for wiki-server sync. */
export interface ScoreRecord {
  /** Deterministic 10-char ID (generated from natural key). */
  id: string;
  /** Entity stable ID for the politician (may be a placeholder if not matched). */
  politicianEntityId: string;
  /** Human-readable name. */
  politicianDisplayName: string;
  /** Short identifier for the scoring organization (e.g. "LCV"). */
  scorerOrg: string;
  /** Entity stable ID for the scoring org, if known. */
  scorerEntityId: string | null;
  /** Numeric score value. */
  score: number;
  /** Maximum possible score (default 100). */
  maxScore: number;
  /** Year the score applies to. */
  year: number;
  /** Category of score (e.g. "environmental", "animal_welfare"). */
  scoreType: string | null;
  /** URL where the score was found. */
  sourceUrl: string | null;
  /** Additional notes. */
  notes: string | null;
}

/** Result from a source fetcher. */
export interface FetchResult {
  source: string;
  year: number;
  records: ScoreRecord[];
  warnings: string[];
  /** Whether real data was fetched vs sample data used as fallback. */
  usedSampleData: boolean;
}

/** Interface that each scorecard source must implement. */
export interface ScorecardSource {
  /** Short identifier (e.g. "lcv", "humane-world"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Fetch scores for a given year. */
  fetch(year: number): Promise<FetchResult>;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 10-char alphanumeric ID from a natural key.
 *
 * The natural key for a political score is:
 *   `{scorerOrg}:{politicianDisplayName}:{year}`
 *
 * This ensures the same score from the same source for the same person and
 * year always gets the same ID, enabling idempotent upserts.
 */
export function generateScoreId(
  scorerOrg: string,
  politicianName: string,
  year: number,
): string {
  return generateDeterministicId("political-score", scorerOrg, politicianName, year);
}

/**
 * Generate a placeholder entity ID for a politician who doesn't have a
 * real entity in the database yet. Uses the same deterministic hash
 * approach so re-imports produce the same placeholder.
 */
export function placeholderEntityId(name: string): string {
  return "sid_" + generateDeterministicId("politician", name.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Sync to wiki-server
// ---------------------------------------------------------------------------

const SYNC_BATCH_SIZE = 200;

interface SyncResult {
  totalRecords: number;
  upserted: number;
  batches: number;
  errors: string[];
}

/**
 * Sync score records to the wiki-server in batches.
 */
export async function syncScoresToServer(
  records: ScoreRecord[],
): Promise<SyncResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return {
      totalRecords: records.length,
      upserted: 0,
      batches: 0,
      errors: ["LONGTERMWIKI_SERVER_URL not configured — cannot sync"],
    };
  }

  const result: SyncResult = {
    totalRecords: records.length,
    upserted: 0,
    batches: 0,
    errors: [],
  };

  // Process in batches of SYNC_BATCH_SIZE
  for (let i = 0; i < records.length; i += SYNC_BATCH_SIZE) {
    const batch = records.slice(i, i + SYNC_BATCH_SIZE);
    result.batches++;

    const syncItems = batch.map((r) => ({
      id: r.id,
      politicianEntityId: r.politicianEntityId,
      politicianDisplayName: r.politicianDisplayName,
      scorerOrg: r.scorerOrg,
      scorerEntityId: r.scorerEntityId,
      score: r.score,
      maxScore: r.maxScore,
      year: r.year,
      scoreType: r.scoreType,
      sourceUrl: r.sourceUrl,
      notes: r.notes,
    }));

    const apiResult: ApiResult<{ upserted: number }> = await apiRequest(
      "POST",
      "/api/political-scores/sync",
      { items: syncItems },
    );

    if (apiResult.ok) {
      result.upserted += apiResult.data.upserted;
    } else {
      result.errors.push(
        `Batch ${result.batches} (${batch.length} items) failed: ${apiResult.message}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

import { lcvSource } from "./sources/lcv.ts";
import { humaneWorldSource } from "./sources/humane-world.ts";
import { councilLivableWorldSource } from "./sources/council-livable-world.ts";

const SOURCE_REGISTRY: Record<string, ScorecardSource> = {
  lcv: lcvSource,
  "humane-world": humaneWorldSource,
  "council-livable-world": councilLivableWorldSource,
};

export function getAvailableSources(): string[] {
  return Object.keys(SOURCE_REGISTRY);
}

export function getSource(id: string): ScorecardSource | undefined {
  return SOURCE_REGISTRY[id];
}

export function getAllSources(): ScorecardSource[] {
  return Object.values(SOURCE_REGISTRY);
}
