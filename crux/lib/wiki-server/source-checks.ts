/**
 * Source-Check Verdicts API — wiki-server client module
 *
 * Provides functions to fetch source-check verdicts from the wiki-server.
 * Used by the auto-update pipeline to skip pages with contradicted verdicts.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { SourceChecksRoute } from '../../../apps/wiki-server/src/routes/source-check/source-checks.ts';

type RpcClient = ReturnType<typeof hc<SourceChecksRoute>>;

// ---------------------------------------------------------------------------
// Response types (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

export type VerdictsResponse = InferResponseType<RpcClient['verdicts']['$get'], 200>;
export type VerdictEntry = VerdictsResponse['verdicts'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch source-check verdicts filtered by verdict type.
 *
 * @param verdict - The verdict type to filter by (e.g., 'contradicted')
 * @param limit - Maximum number of verdicts to return (default: 200)
 * @returns ApiResult containing the verdicts array and total count
 */
export async function getVerdictsByType(
  verdict: string,
  limit = 200,
): Promise<ApiResult<VerdictsResponse>> {
  return apiRequest<VerdictsResponse>(
    'GET',
    `/api/source-checks/verdicts?verdict=${encodeURIComponent(verdict)}&limit=${limit}`,
  );
}

/**
 * Fetch all contradicted source-check verdicts and return the set of
 * entity IDs (stableIds) that have at least one contradicted verdict.
 *
 * This is a convenience wrapper for use by the auto-update pipeline.
 * Returns an empty set (not an error) if the wiki-server is unavailable,
 * following the best-effort pattern from error-handling.md.
 */
export async function getContradictedEntityIds(): Promise<Set<string>> {
  const result = await getVerdictsByType('contradicted', 200);

  if (!result.ok) {
    // Best-effort: wiki-server unavailable → proceed without filtering
    console.warn(`[source-checks] Failed to fetch contradicted verdicts: ${result.message}`);
    return new Set();
  }

  const { verdicts, total } = result.data;
  if (total > verdicts.length) {
    console.warn(`[source-checks] Fetched ${verdicts.length}/${total} contradicted verdicts — some entities may not be filtered`);
  }

  const entityIds = new Set<string>();
  for (const verdict of verdicts) {
    if (verdict.entityId) {
      entityIds.add(verdict.entityId);
    }
  }
  return entityIds;
}
