/**
 * Improve Run Artifacts API — wiki-server client module
 *
 * Saves and retrieves intermediate artifacts from V2 orchestrator
 * and page-improver pipeline runs. See GitHub issue #826.
 * Response types are imported from api-types.ts (single source of truth).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  SaveArtifacts,
  SaveArtifactsResult,
  ArtifactRow,
  GetArtifactsResult,
  GetArtifactsPagedResult,
  ArtifactStatsResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type SaveArtifactsInput = SaveArtifacts;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { SaveArtifactsResult, GetArtifactsResult, GetArtifactsPagedResult, ArtifactStatsResult };

/** Backward-compatible alias for ArtifactRow. */
export type ArtifactEntry = ArtifactRow;

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
