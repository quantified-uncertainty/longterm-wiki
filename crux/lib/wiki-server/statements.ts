/**
 * Statements API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type (StatementsRoute).
 */

import { apiRequest, BATCH_TIMEOUT_MS, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { StatementsRoute } from '../../../apps/wiki-server/src/routes/statements.ts';

// ---------------------------------------------------------------------------
// RPC type inference — response shapes derived from the server route
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<StatementsRoute>>;

export type ListStatementsResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type ByEntityResult = InferResponseType<RpcClient['by-entity']['$get'], 200>;
export type ByPageResult = InferResponseType<RpcClient['by-page']['$get'], 200>;
export type ByPageSummaryResult = InferResponseType<RpcClient['by-page']['summary']['$get'], 200>;
export type CreateStatementResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type BatchCreateResult = InferResponseType<RpcClient['batch']['$post'], 201>;
export type ClearByEntityResult = InferResponseType<RpcClient['clear-by-entity']['$post'], 200>;
export type StatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type PropertiesResult = InferResponseType<RpcClient['properties']['$get'], 200>;
export type BatchScoreResult = InferResponseType<RpcClient['score']['$post'], 200>;
export type CoverageScoreResult = InferResponseType<RpcClient['coverage-score']['$post'], 201>;
export type CoverageScoresResult = InferResponseType<RpcClient['coverage-scores']['$get'], 200>;

export type StatementRow = ListStatementsResult['statements'][number];

// ---------------------------------------------------------------------------
// Types — statement input for batch creation
// ---------------------------------------------------------------------------

export interface CreateStatementInput {
  variety: 'structured' | 'attributed';
  statementText: string;
  subjectEntityId: string;
  propertyId?: string | null;
  qualifierKey?: string | null;
  valueNumeric?: number | null;
  valueUnit?: string | null;
  valueText?: string | null;
  valueEntityId?: string | null;
  valueDate?: string | null;
  valueSeries?: Record<string, unknown> | null;
  validStart?: string | null;
  validEnd?: string | null;
  temporalGranularity?: string | null;
  attributedTo?: string | null;
  note?: string | null;
  sourceFactKey?: string | null;
  claimCategory?: string | null;
  verdict?: string | null;
  verdictScore?: number | null;
  verdictModel?: string | null;
  citations?: Array<{
    resourceId?: string | null;
    url?: string | null;
    sourceQuote?: string | null;
    locationNote?: string | null;
    isPrimary?: boolean;
  }>;
  pageReferences?: Array<{
    pageIdInt: number;
    footnoteResourceId?: string | null;
    section?: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getStatementsByEntity(
  entityId: string,
  opts?: { includeChildren?: boolean },
): Promise<ApiResult<ByEntityResult>> {
  let path = `/api/statements/by-entity?entityId=${encodeURIComponent(entityId)}`;
  if (opts?.includeChildren) path += '&includeChildren=true';
  return apiRequest<ByEntityResult>('GET', path);
}

export async function getStatementsByPage(
  pageIdInt: number,
): Promise<ApiResult<ByPageResult>> {
  return apiRequest<ByPageResult>(
    'GET',
    `/api/statements/by-page?pageId=${pageIdInt}`,
  );
}

export async function getStatementsStats(): Promise<ApiResult<StatsResult>> {
  return apiRequest<StatsResult>('GET', '/api/statements/stats');
}

export async function getProperties(): Promise<ApiResult<PropertiesResult>> {
  return apiRequest<PropertiesResult>('GET', '/api/statements/properties');
}

export interface UpsertPropertyInput {
  id: string;
  label: string;
  category: string;
  description?: string | null;
  entityTypes?: string[];
  valueType?: 'number' | 'string' | 'entity' | 'date';
  defaultUnit?: string | null;
  stalenessCadence?: string | null;
  unitFormatId?: string | null;
}

type UpsertPropertiesResult = InferResponseType<RpcClient['properties']['upsert']['$post'], 200>;

export async function upsertProperties(
  props: UpsertPropertyInput[],
): Promise<ApiResult<UpsertPropertiesResult>> {
  return apiRequest<UpsertPropertiesResult>(
    'POST',
    '/api/statements/properties/upsert',
    { properties: props },
  );
}

export async function createStatement(
  input: CreateStatementInput,
): Promise<ApiResult<CreateStatementResult>> {
  return apiRequest<CreateStatementResult>(
    'POST',
    '/api/statements',
    input,
  );
}

export async function createStatementBatch(
  items: CreateStatementInput[],
): Promise<ApiResult<BatchCreateResult>> {
  return apiRequest<BatchCreateResult>(
    'POST',
    '/api/statements/batch',
    { statements: items },
    BATCH_TIMEOUT_MS,
  );
}

export async function clearStatementsByEntity(
  entityId: string,
): Promise<ApiResult<ClearByEntityResult>> {
  return apiRequest<ClearByEntityResult>(
    'POST',
    '/api/statements/clear-by-entity',
    { entityId },
  );
}

export interface PatchStatementInput {
  status?: 'active' | 'superseded' | 'retracted';
  variety?: 'structured' | 'attributed';
  statementText?: string;
  subjectEntityId?: string;
  propertyId?: string | null;
  qualifierKey?: string | null;
  validStart?: string | null;
  validEnd?: string | null;
  attributedTo?: string | null;
  archiveReason?: string | null;
  verdict?: string | null;
  verdictScore?: number | null;
  verdictQuotes?: string | null;
  verdictModel?: string | null;
  note?: string | null;
}

export async function patchStatement(
  id: number,
  input: PatchStatementInput,
): Promise<ApiResult<{ statement: StatementRow; ok: boolean }>> {
  return apiRequest<{ statement: StatementRow; ok: boolean }>(
    'PATCH',
    `/api/statements/${id}`,
    input,
  );
}

export async function listStatements(
  opts: { entityId?: string; propertyId?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<ApiResult<ListStatementsResult>> {
  const params = new URLSearchParams();
  if (opts.entityId) params.set('entityId', opts.entityId);
  if (opts.propertyId) params.set('propertyId', opts.propertyId);
  if (opts.status) params.set('status', opts.status);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return apiRequest<ListStatementsResult>(
    'GET',
    `/api/statements${qs ? `?${qs}` : ''}`,
  );
}

export async function cleanupStatements(
  entityId: string,
  dryRun = true,
): Promise<ApiResult<{ dryRun: boolean; retracted: number; empty: number; totalToDelete?: number; deleted?: number; ok: boolean }>> {
  return apiRequest(
    'POST',
    '/api/statements/cleanup',
    { entityId, dryRun },
  );
}

// ---------------------------------------------------------------------------
// Quality scoring API functions
// ---------------------------------------------------------------------------

export interface BatchScoreInput {
  statementId: number;
  qualityScore: number;
  qualityDimensions: Record<string, number>;
}

export async function batchUpdateScores(
  scores: BatchScoreInput[],
): Promise<ApiResult<BatchScoreResult>> {
  return apiRequest<BatchScoreResult>(
    'POST',
    '/api/statements/score',
    { scores },
    BATCH_TIMEOUT_MS,
  );
}

export async function storeCoverageScore(input: {
  entityId: string;
  coverageScore: number;
  categoryScores: Record<string, number>;
  statementCount: number;
  qualityAvg?: number | null;
}): Promise<ApiResult<CoverageScoreResult>> {
  return apiRequest<CoverageScoreResult>(
    'POST',
    '/api/statements/coverage-score',
    input,
  );
}

export async function getCoverageScores(
  entityId: string,
  limit = 20,
): Promise<ApiResult<CoverageScoresResult>> {
  return apiRequest<CoverageScoresResult>(
    'GET',
    `/api/statements/coverage-scores?entityId=${encodeURIComponent(entityId)}&limit=${limit}`,
  );
}
