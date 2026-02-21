/**
 * Hallucination Risk API — wiki-server client module
 */

import { batchedRequest, getServerUrl, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RiskSnapshot {
  pageId: string;
  score: number;
  level: string;
  factors: string[];
  integrityIssues?: string[];
}

interface RiskBatchResult {
  inserted: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RISK_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Record hallucination risk snapshots for multiple pages.
 * Splits into batches of 100.
 */
export async function recordRiskSnapshots(
  snapshots: RiskSnapshot[],
): Promise<ApiResult<{ inserted: number }>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalInserted = 0;

  for (let i = 0; i < snapshots.length; i += RISK_BATCH_SIZE) {
    const batch = snapshots.slice(i, i + RISK_BATCH_SIZE);
    const result = await batchedRequest<RiskBatchResult>(
      'POST',
      '/api/hallucination-risk/batch',
      { snapshots: batch },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Risk snapshot batch failed: ${result.message}`);
      return result;
    }

    totalInserted += result.data.inserted;
  }

  return { ok: true, data: { inserted: totalInserted } };
}

// ---------------------------------------------------------------------------
// Backward-compatible wrapper
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const recordRiskSnapshots_compat = async (snapshots: RiskSnapshot[]) =>
  unwrap(await recordRiskSnapshots(snapshots));
