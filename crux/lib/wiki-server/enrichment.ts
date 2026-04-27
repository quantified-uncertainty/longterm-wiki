/**
 * Enrichment API — wiki-server client module.
 *
 * Typed RPC wrappers around `/api/enrichment/*`. Response types are inferred
 * from the Hono RPC route via `InferResponseType<>` so a server-side schema
 * change fails the crux build instead of breaking silently at runtime.
 *
 * Covers three call sites:
 *   - `proposeEnrichment` — the defensive gate (QUA-632); used by the
 *     tablebase loop + T1/T3 importers.
 *   - `upsertTargets` / `getCoverage` / `getRunById` — the burst tooling
 *     (QUA-643): denominators, acceptance report, spend watchdog.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { EnrichmentRoute } from '../../../apps/wiki-server/src/routes/enrichment/enrichment.ts';
import { checkT1Authority } from '../../../apps/wiki-server/src/routes/enrichment/t1-allowlist.ts';

// ---------------------------------------------------------------------------
// Types — inferred from the Hono RPC route
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<EnrichmentRoute>>;

/** Response body when `/propose` accepts a record (HTTP 200). */
export type ProposeAcceptedResponse = InferResponseType<
  RpcClient['propose']['$post'],
  200
>;

/** Response body when `/propose` rejects (HTTP 400). */
export type ProposeRejectedResponse = InferResponseType<
  RpcClient['propose']['$post'],
  400
>;

export type TargetsUpsertResult = InferResponseType<RpcClient['targets']['$post'], 200>;
export type ListTargetsResult = InferResponseType<RpcClient['targets']['$get'], 200>;
export type CoverageResult = InferResponseType<RpcClient['coverage']['$get'], 200>;
export type RunsResult = InferResponseType<RpcClient['runs']['$get'], 200>;

/** One row from the coverage report. Shared with reopener + CLI. */
export type CoverageRow = CoverageResult['coverage'][number];
/** One run row from the /runs list. Consumed by the watchdog. */
export type RunRow = RunsResult['runs'][number];

/** Record types the endpoint currently accepts. Keep in sync with
 *  `SUPPORTED_RECORD_TYPES` in `apps/wiki-server/src/routes/enrichment/enrichment.ts`. */
export type SupportedRecordType =
  | 'grants'
  | 'personnel'
  | 'funding-rounds'
  | 'benchmark-results';

export type EnrichmentTier = 'T1' | 'T2' | 'T3';

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

/**
 * Body of `POST /api/enrichment/propose`. Shape matches the server's
 * `ProposeRequestSchema`. Kept as a plain interface rather than re-exported
 * from the Zod schema so crux can build requests without pulling in Zod
 * at runtime.
 */
export interface ProposeRequest {
  tier: EnrichmentTier;
  recordType: SupportedRecordType;
  /** The record payload (shape validated by the per-type sync handler). */
  row: Record<string, unknown>;
  sourceUrl: string;
  sourceContentHash?: string;

  // T2/T3 fields (ignored for T1)
  verdict?: 'confirmed' | 'contradicted' | 'outdated' | 'partial' | 'unverifiable';
  confidence?: number;
  quotedText?: string;
  reasoning?: string;
  sourceContent?: string;
  checkerModel?: string;

  runId?: string;
  /** USD cost the caller paid for the verdict-LLM step on this proposal.
   *  Accumulates into `enrichment_runs.cost_usd` when `runId` is set. */
  costUsd?: number;
  /** Phase-1 endpoint rejects non-null `fieldName`. Always send null/undefined. */
  fieldName?: null;
}

export interface TargetsUpsertInput {
  targets: Array<{
    entityId: string;
    recordType: string;
    estimatedTotal: number;
    targetPct?: number;
    basis?: string;
    confidence?: 'high' | 'medium' | 'low';
  }>;
}

export interface CoverageQuery {
  recordType?: string;
  entityId?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Submit one record through the enrichment gate.
 *
 * Returns `{ ok: true, data }` with `status: "accepted"` on HTTP 200, or
 * `{ ok: false, error: "bad_request", message }` when the gate rejects.
 * Callers should surface the rejection reason verbatim to the agent so it
 * can learn which sources/verdicts are accepted.
 */
export function proposeEnrichment(
  body: ProposeRequest,
): Promise<ApiResult<ProposeAcceptedResponse>> {
  return apiRequest<ProposeAcceptedResponse>(
    'POST',
    '/api/enrichment/propose',
    body,
  );
}

export async function upsertTargets(
  body: TargetsUpsertInput,
): Promise<ApiResult<TargetsUpsertResult>> {
  return apiRequest<TargetsUpsertResult>('POST', '/api/enrichment/targets', body);
}

export async function getCoverage(
  q: CoverageQuery = {},
): Promise<ApiResult<CoverageResult>> {
  const params = new URLSearchParams();
  if (q.recordType) params.set('recordType', q.recordType);
  if (q.entityId) params.set('entityId', q.entityId);
  const qs = params.toString();
  return apiRequest<CoverageResult>(
    'GET',
    `/api/enrichment/coverage${qs ? `?${qs}` : ''}`,
  );
}

export async function getRunById(
  runId: string,
): Promise<ApiResult<RunsResult>> {
  return apiRequest<RunsResult>(
    'GET',
    `/api/enrichment/runs?id=${encodeURIComponent(runId)}`,
  );
}

// ---------------------------------------------------------------------------
// T1 client-side check
// ---------------------------------------------------------------------------

/**
 * Check whether `(sourceUrl, recordType)` is on the T1 authority allowlist.
 *
 * Re-exports `checkT1Authority` from the server-side module so the caller
 * can make a local routing decision (T1 → `/propose`, else T3 or fall back)
 * without a round-trip. The server performs its own check — this is purely
 * an optimization. If the pattern list drifts, the server is authoritative.
 */
export function isT1UrlAuthoritative(
  sourceUrl: string,
  recordType: SupportedRecordType,
): boolean {
  return checkT1Authority(sourceUrl, recordType, null).matched;
}
