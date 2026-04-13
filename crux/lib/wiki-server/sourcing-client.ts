/**
 * Source-Check API — wiki-server client module
 *
 * Handles sourcing evidence and verdict storage.
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
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
export type ListVerdictsResult = InferResponseType<RpcClient['verdicts']['$get'], 200>;
export type VerdictByRecordResult = InferResponseType<RpcClient['verdicts'][':recordType'][':recordId']['$get'], 200>;
export type DueForRecheckResult = InferResponseType<RpcClient['due-for-recheck']['$get'], 200>;
export type EvidenceByRecordResult = InferResponseType<RpcClient['evidence'][':recordType'][':recordId']['$get'], 200>;
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

/** Get sourcing statistics. */
export async function getSourcingStats(): Promise<ApiResult<SourcingStatsResult>> {
  return apiRequest<SourcingStatsResult>('GET', '/api/sourcing/stats');
}

/**
 * Clean up orphaned source-check rows for deleted records (QUA-149).
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
