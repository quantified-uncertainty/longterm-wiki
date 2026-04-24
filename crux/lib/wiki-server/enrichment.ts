/**
 * Enrichment API — wiki-server client module (QUA-655).
 *
 * Typed RPC client for `POST /api/enrichment/propose` — the defensive
 * enrichment gate shipped in QUA-632 Phase 1 (PR #4527). Used by the
 * tablebase loop (`crux tb tablebase loop --via-propose`) to route writes
 * through the server-validated tier gate instead of direct `/sync` calls.
 *
 * Response types are inferred from the Hono RPC route type via
 * `InferResponseType<>`, matching the pattern in sibling files
 * (`benchmark-results.ts`, `sourcing-client.ts`, etc.).
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

/** Record types the endpoint currently accepts. Keep in sync with
 *  `SUPPORTED_RECORD_TYPES` in `apps/wiki-server/src/routes/enrichment/enrichment.ts`. */
export type SupportedRecordType =
  | 'grants'
  | 'personnel'
  | 'funding-rounds'
  | 'benchmark-results';

export type EnrichmentTier = 'T1' | 'T2' | 'T3';

// ---------------------------------------------------------------------------
// Request payload
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
  /** Phase-1 endpoint rejects non-null `fieldName`. Always send null/undefined. */
  fieldName?: null;
}

// ---------------------------------------------------------------------------
// API function
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
