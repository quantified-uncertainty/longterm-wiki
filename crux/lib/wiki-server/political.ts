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

// ---------------------------------------------------------------------------
// Types — Races
// ---------------------------------------------------------------------------

type RacesRpc = ReturnType<typeof hc<PoliticalRacesRoute>>;

export type RaceStatsResult = InferResponseType<RacesRpc['stats']['$get'], 200>;
export type RaceAllResult = InferResponseType<RacesRpc['all']['$get'], 200>;
export type RaceSyncResult = InferResponseType<RacesRpc['sync']['$post'], 200>;
export type CandidateSyncResult = InferResponseType<RacesRpc['candidates']['sync']['$post'], 200>;
export type CandidatesAllResult = InferResponseType<RacesRpc['candidates']['all']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Scores
// ---------------------------------------------------------------------------

type ScoresRpc = ReturnType<typeof hc<PoliticalScoresRoute>>;

export type ScoreStatsResult = InferResponseType<ScoresRpc['stats']['$get'], 200>;
export type ScoreSyncResult = InferResponseType<ScoresRpc['sync']['$post'], 200>;
export type ScoreAllResult = InferResponseType<ScoresRpc['all']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Offices
// ---------------------------------------------------------------------------

type OfficesRpc = ReturnType<typeof hc<PoliticalOfficesRoute>>;

export type OfficeStatsResult = InferResponseType<OfficesRpc['stats']['$get'], 200>;
export type OfficeSyncResult = InferResponseType<OfficesRpc['sync']['$post'], 200>;
export type OfficeAllResult = InferResponseType<OfficesRpc['all']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Votes
// ---------------------------------------------------------------------------

type VotesRpc = ReturnType<typeof hc<PoliticalVotesRoute>>;

export type VoteStatsResult = InferResponseType<VotesRpc['stats']['$get'], 200>;
export type VoteSyncResult = InferResponseType<VotesRpc['sync']['$post'], 200>;
export type VoteAllResult = InferResponseType<VotesRpc['all']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — Campaign Finance
// ---------------------------------------------------------------------------

type FinanceRpc = ReturnType<typeof hc<CampaignFinanceRoute>>;

export type FinanceStatsResult = InferResponseType<FinanceRpc['stats']['$get'], 200>;
export type FinanceSyncResult = InferResponseType<FinanceRpc['sync']['$post'], 200>;

// ---------------------------------------------------------------------------
// API functions — Races
// ---------------------------------------------------------------------------

export async function getRaceStats(): Promise<ApiResult<RaceStatsResult>> {
  return apiRequest<RaceStatsResult>('GET', '/api/political-races/stats');
}

export async function getAllRaces(
  options?: { limit?: number; offset?: number; cycle?: string },
): Promise<ApiResult<RaceAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.cycle) params.set('cycle', options.cycle);
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
