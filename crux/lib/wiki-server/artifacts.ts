/**
 * Improve Run Artifacts API — wiki-server client module
 *
 * Saves and retrieves intermediate artifacts from V2 orchestrator
 * and page-improver pipeline runs. See GitHub issue #826.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { SaveArtifacts } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SaveArtifactsInput = SaveArtifacts;

export interface SaveArtifactsResult {
  id: number;
  pageId: string;
  engine: string;
  startedAt: string;
  createdAt: string;
}

export interface ArtifactEntry {
  id: number;
  pageId: string;
  engine: string;
  tier: string;
  directions: string | null;
  startedAt: string;
  completedAt: string | null;
  durationS: number | null;
  totalCost: number | null;
  sourceCache: unknown;
  researchSummary: string | null;
  citationAudit: unknown;
  costEntries: unknown;
  costBreakdown: Record<string, number> | null;
  sectionDiffs: unknown;
  qualityMetrics: unknown;
  qualityGatePassed: boolean | null;
  qualityGaps: string[] | null;
  toolCallCount: number | null;
  refinementCycles: number | null;
  phasesRun: string[] | null;
  createdAt: string;
}

export interface GetArtifactsResult {
  entries: ArtifactEntry[];
}

export interface GetArtifactsPagedResult {
  entries: ArtifactEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArtifactStatsResult {
  totalRuns: number;
  byEngine: Record<string, number>;
  byTier: Record<string, number>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Save artifacts from an improve run (orchestrator v2 or page-improver v1).
 * Fire-and-forget safe — callers should log but not throw on failure.
 */
export async function saveArtifacts(
  input: SaveArtifactsInput,
): Promise<ApiResult<SaveArtifactsResult>> {
  return apiRequest<SaveArtifactsResult>('POST', '/api/artifacts', input, undefined, 'content');
}

/** Get artifacts for a specific page (most recent first). */
export async function getArtifactsByPage(
  pageId: string,
  limit = 10,
): Promise<ApiResult<GetArtifactsResult>> {
  return apiRequest<GetArtifactsResult>(
    'GET',
    `/api/artifacts/by-page?page_id=${encodeURIComponent(pageId)}&limit=${limit}`,
  );
}

/** Get all artifacts (paginated, most recent first). */
export async function getArtifacts(
  limit = 20,
  offset = 0,
): Promise<ApiResult<GetArtifactsPagedResult>> {
  return apiRequest<GetArtifactsPagedResult>(
    'GET',
    `/api/artifacts/all?limit=${limit}&offset=${offset}`,
  );
}

/** Get a single artifact by ID. */
export async function getArtifact(
  id: number,
): Promise<ApiResult<ArtifactEntry>> {
  return apiRequest<ArtifactEntry>('GET', `/api/artifacts/${id}`);
}

/** Get aggregate statistics about stored artifacts. */
export async function getArtifactStats(): Promise<ApiResult<ArtifactStatsResult>> {
  return apiRequest<ArtifactStatsResult>('GET', '/api/artifacts/stats');
}
