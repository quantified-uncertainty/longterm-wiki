/**
 * Improve Run Artifacts API — wiki-server client module
 *
 * Saves and retrieves intermediate artifacts from V2 orchestrator
 * and page-improver pipeline runs. See GitHub issue #826.
 * Response types are inferred via Hono RPC InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ArtifactsRoute } from '../../../apps/wiki-server/src/routes/artifacts.ts';
import type { SaveArtifacts } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// RPC client type (used only for response type inference)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ArtifactsRoute>>;

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type SaveArtifactsInput = SaveArtifacts;

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

export type SaveArtifactsResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type GetArtifactsResult = InferResponseType<RpcClient['by-page']['$get'], 200>;
export type GetArtifactsPagedResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ArtifactStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

/** ArtifactEntry inferred from the single-artifact endpoint. */
export type ArtifactEntry = InferResponseType<RpcClient[':id']['$get'], 200>;

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
  return apiRequest<SaveArtifactsResult>('POST', '/api/artifacts', input);
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
