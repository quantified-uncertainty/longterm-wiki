/**
 * Political Data API — wiki-server client module
 *
 * Covers political races, scores, offices, votes, and campaign finance.
 * Response types are inferred from the Hono RPC route types via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { PoliticalRacesRoute } from '../../../apps/wiki-server/src/routes/tablebase/political-races.ts';
import type { PoliticalScoresRoute } from '../../../apps/wiki-server/src/routes/tablebase/political-scores.ts';
import type { PoliticalOfficesRoute } from '../../../apps/wiki-server/src/routes/tablebase/political-offices.ts';
import type { PoliticalVotesRoute } from '../../../apps/wiki-server/src/routes/tablebase/political-votes.ts';
import type { CampaignFinanceRoute } from '../../../apps/wiki-server/src/routes/tablebase/campaign-finance.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

// All factory-backed /sync handlers share the same SyncResponse shape. The
// createSyncHandler factory returns Promise<Response>, so InferResponseType
// collapses to {} — import the concrete factory response type instead.

// ---------------------------------------------------------------------------
// Types — Races
// ---------------------------------------------------------------------------

type RacesRpc = ReturnType<typeof hc<PoliticalRacesRoute>>;

export type RaceStatsResult = InferResponseType<RacesRpc['stats']['$get'], 200>;
export type RaceAllResult = InferResponseType<RacesRpc['all']['$get'], 200>;
export type RaceSyncResult = SyncResponse;
export type RaceDetailResult = InferResponseType<RacesRpc[':id']['$get'], 200>;
export type CandidateSyncResult = SyncResponse;
export type CandidatesAllResult = InferResponseType<RacesRpc['candidates']['all']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Scores
// ---------------------------------------------------------------------------

type ScoresRpc = ReturnType<typeof hc<PoliticalScoresRoute>>;

export type ScoreStatsResult = InferResponseType<ScoresRpc['stats']['$get'], 200>;
export type ScoreSyncResult = SyncResponse;
export type ScoreAllResult = InferResponseType<ScoresRpc['all']['$get'], 200>;
export type ScoreByEntityResult = InferResponseType<ScoresRpc['by-entity'][':entityId']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Offices
// ---------------------------------------------------------------------------

type OfficesRpc = ReturnType<typeof hc<PoliticalOfficesRoute>>;

export type OfficeStatsResult = InferResponseType<OfficesRpc['stats']['$get'], 200>;
export type OfficeSyncResult = SyncResponse;
export type OfficeAllResult = InferResponseType<OfficesRpc['all']['$get'], 200>;
export type OfficeByEntityResult = InferResponseType<OfficesRpc['by-entity'][':entityId']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Votes
// ---------------------------------------------------------------------------

type VotesRpc = ReturnType<typeof hc<PoliticalVotesRoute>>;

export type VoteStatsResult = InferResponseType<VotesRpc['stats']['$get'], 200>;
export type VoteSyncResult = SyncResponse;
export type VoteAllResult = InferResponseType<VotesRpc['all']['$get'], 200>;
export type VoteByEntityResult = InferResponseType<VotesRpc['by-entity'][':entityId']['$get'], 200>;
export type VoteByLegislationResult = InferResponseType<VotesRpc['by-legislation'][':legislationId']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Campaign Finance
// ---------------------------------------------------------------------------

type FinanceRpc = ReturnType<typeof hc<CampaignFinanceRoute>>;

export type FinanceStatsResult = InferResponseType<FinanceRpc['stats']['$get'], 200>;
export type FinanceSyncResult = SyncResponse;
export type FinanceAllResult = InferResponseType<FinanceRpc['all']['$get'], 200>;
export type FinanceByEntityResult = InferResponseType<FinanceRpc['by-entity'][':entityId']['$get'], 200>;

// ---------------------------------------------------------------------------
// API functions — Races
// ---------------------------------------------------------------------------

export async function getRaceStats(): Promise<ApiResult<RaceStatsResult>> {
  return apiRequest<RaceStatsResult>('GET', '/api/political-races/stats');
}

export async function getRace(id: string): Promise<ApiResult<RaceDetailResult>> {
  return apiRequest<RaceDetailResult>('GET', `/api/political-races/${encodeURIComponent(id)}`);
}

export async function getAllRaces(
  options?: { limit?: number; offset?: number; cycle?: string; status?: string; level?: string; state?: string },
): Promise<ApiResult<RaceAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.cycle) params.set('cycle', options.cycle);
  if (options?.status) params.set('status', options.status);
  if (options?.level) params.set('level', options.level);
  if (options?.state) params.set('state', options.state);
  const qs = params.toString();
  return apiRequest<RaceAllResult>('GET', `/api/political-races/all${qs ? `?${qs}` : ''}`);
}

export async function syncRaces(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<RaceSyncResult>> {
  return apiRequest<RaceSyncResult>('POST', '/api/political-races/sync', { items });
}

export async function getAllCandidates(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<CandidatesAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<CandidatesAllResult>(
    'GET',
    `/api/political-races/candidates/all${qs ? `?${qs}` : ''}`,
  );
}

export async function syncCandidates(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<CandidateSyncResult>> {
  return apiRequest<CandidateSyncResult>('POST', '/api/political-races/candidates/sync', { items });
}

// ---------------------------------------------------------------------------
// API functions — Scores
// ---------------------------------------------------------------------------

export async function getScoreStats(): Promise<ApiResult<ScoreStatsResult>> {
  return apiRequest<ScoreStatsResult>('GET', '/api/political-scores/stats');
}

export async function getAllScores(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<ScoreAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<ScoreAllResult>('GET', `/api/political-scores/all${qs ? `?${qs}` : ''}`);
}

export async function syncScores(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<ScoreSyncResult>> {
  return apiRequest<ScoreSyncResult>('POST', '/api/political-scores/sync', { items });
}

export async function getScoresByEntity(
  entityId: string,
): Promise<ApiResult<ScoreByEntityResult>> {
  return apiRequest<ScoreByEntityResult>(
    'GET',
    `/api/political-scores/by-entity/${encodeURIComponent(entityId)}`,
  );
}

// ---------------------------------------------------------------------------
// API functions — Offices
// ---------------------------------------------------------------------------

export async function getOfficeStats(): Promise<ApiResult<OfficeStatsResult>> {
  return apiRequest<OfficeStatsResult>('GET', '/api/political-offices/stats');
}

export async function getAllOffices(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<OfficeAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<OfficeAllResult>('GET', `/api/political-offices/all${qs ? `?${qs}` : ''}`);
}

export async function syncOffices(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<OfficeSyncResult>> {
  return apiRequest<OfficeSyncResult>('POST', '/api/political-offices/sync', { items });
}

export async function getOfficesByEntity(
  entityId: string,
): Promise<ApiResult<OfficeByEntityResult>> {
  return apiRequest<OfficeByEntityResult>(
    'GET',
    `/api/political-offices/by-entity/${encodeURIComponent(entityId)}`,
  );
}

// ---------------------------------------------------------------------------
// API functions — Votes
// ---------------------------------------------------------------------------

export async function getVoteStats(): Promise<ApiResult<VoteStatsResult>> {
  return apiRequest<VoteStatsResult>('GET', '/api/political-votes/stats');
}

export async function syncVotes(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<VoteSyncResult>> {
  return apiRequest<VoteSyncResult>('POST', '/api/political-votes/sync', { items });
}

export async function getAllVotes(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<VoteAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<VoteAllResult>('GET', `/api/political-votes/all${qs ? `?${qs}` : ''}`);
}

export async function getVotesByEntity(
  entityId: string,
  options?: { limit?: number },
): Promise<ApiResult<VoteByEntityResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<VoteByEntityResult>(
    'GET',
    `/api/political-votes/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}

export async function getVotesByLegislation(
  legislationId: string,
  options?: { limit?: number },
): Promise<ApiResult<VoteByLegislationResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<VoteByLegislationResult>(
    'GET',
    `/api/political-votes/by-legislation/${encodeURIComponent(legislationId)}${qs ? `?${qs}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// API functions — Campaign Finance
// ---------------------------------------------------------------------------

export async function getFinanceStats(): Promise<ApiResult<FinanceStatsResult>> {
  return apiRequest<FinanceStatsResult>('GET', '/api/campaign-finance/stats');
}

export async function syncFinance(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<FinanceSyncResult>> {
  return apiRequest<FinanceSyncResult>('POST', '/api/campaign-finance/sync', { items });
}

export async function getAllFinance(
  options?: { limit?: number; offset?: number; cycle?: string },
): Promise<ApiResult<FinanceAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.cycle) params.set('cycle', options.cycle);
  const qs = params.toString();
  return apiRequest<FinanceAllResult>('GET', `/api/campaign-finance/all${qs ? `?${qs}` : ''}`);
}

export async function getFinanceByEntity(
  entityId: string,
): Promise<ApiResult<FinanceByEntityResult>> {
  return apiRequest<FinanceByEntityResult>(
    'GET',
    `/api/campaign-finance/by-entity/${encodeURIComponent(entityId)}`,
  );
}
