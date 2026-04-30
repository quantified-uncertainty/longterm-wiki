/**
 * Source-Check API — wiki-server client module
 *
 * Handles sourcing evidence and verdict storage.
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, batchedRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { SourcingRoute } from '../../../apps/wiki-server/src/routes/sourcing/sourcing.ts';
import type {
  UrlSuggestionsRoute,
  SuggestionStatus,
  SourceProvider,
} from '../../../apps/wiki-server/src/routes/sourcing/url-suggestions.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<SourcingRoute>>;

export type StoreEvidenceResult = InferResponseType<RpcClient['evidence']['$post'], 201>;
export type StoreVerdictResult = InferResponseType<RpcClient['verdicts']['$post'], 200>;
export type RecomputeVerdictResult = InferResponseType<
  RpcClient['verdicts']['recompute']['$post'],
  200
>;
export type ListVerdictsResult = InferResponseType<RpcClient['verdicts']['$get'], 200>;
export type VerdictByRecordResult = InferResponseType<RpcClient['verdicts'][':recordType'][':recordId']['$get'], 200>;
export type DueForRecheckResult = InferResponseType<RpcClient['due-for-recheck']['$get'], 200>;
export type EvidenceByRecordResult = InferResponseType<RpcClient['evidence'][':recordType'][':recordId']['$get'], 200>;
export type EvidenceByRecordsResult = InferResponseType<RpcClient['evidence']['by-records']['$post'], 200>;
export type SourcingStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type CleanupOrphansResult = InferResponseType<RpcClient['cleanup-orphans']['$post'], 200>;

/** A single verdict entry from the list. */
export type VerdictListEntry = ListVerdictsResult['verdicts'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Store individual sourcing evidence. */
export async function storeEvidence(
  body: Record<string, unknown>,
): Promise<ApiResult<StoreEvidenceResult>> {
  return apiRequest<StoreEvidenceResult>('POST', '/api/sourcing/evidence', body);
}

/** Store an aggregate verdict for a record. */
export async function storeVerdict(
  body: Record<string, unknown>,
): Promise<ApiResult<StoreVerdictResult>> {
  return apiRequest<StoreVerdictResult>('POST', '/api/sourcing/verdicts', body);
}

/**
 * Recompute the aggregate verdict for one (recordType, recordId, fieldName)
 * key from its evidence rows (QUA-791). Server reads
 * `source_check_evidence`, applies the canonical relevance-weighted rule,
 * and upserts `source_check_verdicts`. Use this whenever evidence has been
 * added/changed and the aggregate must be brought in sync — replaces the
 * old "construct a verdict body and POST /verdicts" pattern that was
 * last-writer-wins.
 */
export async function recomputeVerdict(
  body: {
    recordType: string;
    recordId: string;
    fieldName?: string | null;
    entityId?: string | null;
    displayName?: string | null;
    entityDisplayName?: string | null;
  },
): Promise<ApiResult<RecomputeVerdictResult>> {
  return apiRequest<RecomputeVerdictResult>(
    'POST',
    '/api/sourcing/verdicts/recompute',
    body,
  );
}

/** List verdicts with optional filters. */
export async function listVerdicts(
  options?: { recordType?: string; verdict?: string; limit?: number; offset?: number },
): Promise<ApiResult<ListVerdictsResult>> {
  const params = new URLSearchParams();
  if (options?.recordType) params.set('record_type', options.recordType);
  if (options?.verdict) params.set('verdict', options.verdict);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<ListVerdictsResult>(
    'GET',
    `/api/sourcing/verdicts${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Fetch the set of record IDs that already have a row-level verdict for the
 * given recordType. Skips per-field verdicts (fieldName != null) — designed
 * for record types where a row-level verdict means "fully checked" (e.g.,
 * facts). Record types that primarily store field-level verdicts (e.g.,
 * personnel) need a different filter.
 *
 * Paginates against the server's natural page size, terminating when
 * `offset + page.length >= total` so the client doesn't need to know
 * MAX_PAGE_SIZE (avoids silent truncation if the server tightens it).
 *
 * Concurrency note: between page fetches, concurrent verdict writes can
 * shift row ordering (rows are sorted by lastComputedAt desc) and
 * skip/duplicate rows across pages. The Set deduplicates duplicates;
 * skipped rows mean a few facts may be re-verified on the next backfill
 * run — wasted work but not incorrect output. Acceptable for the
 * QUA-851 use case.
 *
 * Used by `crux fb sourcing --where-no-verdict` to skip already-verified
 * facts.
 */
export async function fetchVerdictRecordIds(
  recordType: string,
): Promise<ApiResult<Set<string>>> {
  // Request the server's max page size; if the server clamps it lower,
  // we still terminate correctly via `total`.
  const REQUESTED_LIMIT = 200;
  const ids = new Set<string>();
  let offset = 0;

  while (true) {
    const res = await listVerdicts({ recordType, limit: REQUESTED_LIMIT, offset });
    if (!res.ok) return res;

    for (const v of res.data.verdicts) {
      if (v.fieldName != null) continue;
      ids.add(v.recordId);
    }

    const fetchedSoFar = offset + res.data.verdicts.length;
    if (res.data.verdicts.length === 0 || fetchedSoFar >= res.data.total) break;
    offset = fetchedSoFar;
  }

  return { ok: true, data: ids };
}

/** Get verdicts for a specific record. */
export async function getVerdictByRecord(
  recordType: string,
  recordId: string,
): Promise<ApiResult<VerdictByRecordResult>> {
  return apiRequest<VerdictByRecordResult>(
    'GET',
    `/api/sourcing/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`,
  );
}

/** Get evidence for a specific record. */
export async function getEvidenceByRecord(
  recordType: string,
  recordId: string,
  options?: { limit?: number },
): Promise<ApiResult<EvidenceByRecordResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<EvidenceByRecordResult>(
    'GET',
    `/api/sourcing/evidence/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}${qs ? '?' + qs : ''}`,
  );
}

/**
 * Max records per batch evidence request. Must match the server's
 * `MAX_EVIDENCE_BY_RECORDS` in
 * `apps/wiki-server/src/routes/sourcing/sourcing.ts`. Callers that
 * might exceed this (e.g. scans driven by `--limit` flags) should
 * chunk their input and call `getEvidenceByRecords` per chunk.
 */
export const MAX_EVIDENCE_BY_RECORDS = 1000;

/**
 * Batch-fetch evidence for many records in a single request.
 * Replaces N+1 loops over `getEvidenceByRecord`. The server groups by
 * `recordType` and issues one `IN (...)` query per type.
 *
 * Returns `evidenceByKey[recordKey(rt, rid)]` — records with no evidence
 * are absent from the map (not empty arrays), so callers can distinguish
 * "queried, no evidence" from "skipped".
 *
 * `limitPerRecord` is required: it caps the number of evidence rows
 * returned per record and forces callers to be explicit about payload
 * size. Callers that just need the first `sourceUrl` pass a small value
 * (e.g. 5); auditors that classify every URL pass something larger.
 *
 * Uses `batchedRequest` (30s timeout) because the batched endpoint is
 * inherently slower than a point lookup.
 */
export async function getEvidenceByRecords(
  records: Array<{ recordType: string; recordId: string }>,
  options: { limitPerRecord: number },
): Promise<ApiResult<EvidenceByRecordsResult>> {
  return batchedRequest<EvidenceByRecordsResult>(
    'POST',
    '/api/sourcing/evidence/by-records',
    { records, limitPerRecord: options.limitPerRecord },
  );
}

/** Must match `evidenceRecordKey` in apps/wiki-server/src/routes/sourcing/sourcing.ts. */
export function evidenceRecordKey(recordType: string, recordId: string): string {
  return `${recordType}|${recordId}`;
}

/** Get sourcing statistics. */
export async function getSourcingStats(): Promise<ApiResult<SourcingStatsResult>> {
  return apiRequest<SourcingStatsResult>('GET', '/api/sourcing/stats');
}

/**
 * Clean up orphaned sourcing rows for deleted records (QUA-149).
 *
 * `dryRun` defaults to true — callers must pass `dryRun: false` explicitly
 * to delete. `recordType` scopes cleanup to a single type.
 */
export async function cleanupOrphanVerdicts(
  options?: { dryRun?: boolean; recordType?: string },
): Promise<ApiResult<CleanupOrphansResult>> {
  return apiRequest<CleanupOrphansResult>('POST', '/api/sourcing/cleanup-orphans', {
    dryRun: options?.dryRun ?? true,
    ...(options?.recordType ? { recordType: options.recordType } : {}),
  });
}

// ---------------------------------------------------------------------------
// URL suggestions — QUA-64
// ---------------------------------------------------------------------------

type UrlSuggestionsRpcClient = ReturnType<typeof hc<UrlSuggestionsRoute>>;

export type UrlSuggestionsUpsertResult = InferResponseType<
  UrlSuggestionsRpcClient['index']['$post'],
  200
>;
export type UrlSuggestionsListResult = InferResponseType<
  UrlSuggestionsRpcClient['index']['$get'],
  200
>;

export interface UrlSuggestionInput {
  recordType: string;
  recordId: string;
  fieldName?: string | null;
  entityId?: string | null;
  suggestedUrl: string;
  title?: string | null;
  snippet?: string | null;
  relevanceScore?: number | null;
  sourceProvider: SourceProvider;
  generatorModel?: string | null;
  status?: SuggestionStatus;
  notes?: string | null;
}

/** Batch-upsert URL suggestions. */
export async function upsertUrlSuggestions(
  suggestions: UrlSuggestionInput[],
): Promise<ApiResult<UrlSuggestionsUpsertResult>> {
  return apiRequest<UrlSuggestionsUpsertResult>(
    'POST',
    '/api/sourcing/url-suggestions',
    { suggestions },
  );
}

/** List URL suggestions with optional filters. */
export async function listUrlSuggestions(
  options?: {
    recordType?: string;
    recordId?: string;
    entityId?: string;
    status?: SuggestionStatus;
    limit?: number;
    offset?: number;
  },
): Promise<ApiResult<UrlSuggestionsListResult>> {
  const params = new URLSearchParams();
  if (options?.recordType) params.set('recordType', options.recordType);
  if (options?.recordId) params.set('recordId', options.recordId);
  if (options?.entityId) params.set('entityId', options.entityId);
  if (options?.status) params.set('status', options.status);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<UrlSuggestionsListResult>(
    'GET',
    `/api/sourcing/url-suggestions${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Update a single URL suggestion's status (approve / reject / mark applied).
 * Thin PATCH wrapper over /api/sourcing/url-suggestions/:id. Used by
 * sourcing-apply-suggestions (QUA-591) to mark 'applied' after a successful
 * URL swap + recheck.
 */
export async function updateUrlSuggestionStatus(
  id: number,
  body: { status: SuggestionStatus; reviewedBy?: string; notes?: string | null },
): Promise<ApiResult<{ ok: boolean; id: number }>> {
  return apiRequest<{ ok: boolean; id: number }>(
    'PATCH',
    `/api/sourcing/url-suggestions/${id}`,
    body,
  );
}

/** Get records due for re-check. */
export async function getDueForRecheck(
  options?: { recordType?: string; limit?: number },
): Promise<ApiResult<DueForRecheckResult>> {
  const params = new URLSearchParams();
  if (options?.recordType) params.set('record_type', options.recordType);
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<DueForRecheckResult>(
    'GET',
    `/api/sourcing/due-for-recheck${qs ? `?${qs}` : ''}`,
  );
}
