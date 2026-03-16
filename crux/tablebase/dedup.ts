/**
 * TableBase Dedup
 *
 * Pre-submit deduplication against existing records.
 * Queries the wiki-server for current records and filters out duplicates.
 */

import { apiRequest } from '../lib/wiki-server/client.ts';

interface PersonnelRecord {
  personId: string;
  organizationId: string;
  role: string;
  [key: string]: unknown;
}

interface FundingRoundRecord {
  companyId: string;
  name: string;
  [key: string]: unknown;
}

interface InvestmentRecord {
  companyId: string;
  investorId: string;
  roundName?: string;
  [key: string]: unknown;
}

interface BenchmarkResultRecord {
  benchmarkId: string;
  modelId: string;
  [key: string]: unknown;
}

interface GrantRecord {
  id: string;
  granteeId?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Fetch existing records for an entity
// ---------------------------------------------------------------------------

async function fetchExistingPersonnel(entityId: string): Promise<PersonnelRecord[]> {
  const result = await apiRequest<{ personnel: PersonnelRecord[] }>(
    'GET',
    `/api/personnel/by-entity/${encodeURIComponent(entityId)}?limit=200`,
  );
  return result.ok ? result.data.personnel : [];
}

async function fetchExistingFundingRounds(entityId: string): Promise<FundingRoundRecord[]> {
  const result = await apiRequest<{ fundingRounds: FundingRoundRecord[] }>(
    'GET',
    `/api/funding-rounds/by-entity/${encodeURIComponent(entityId)}?limit=200`,
  );
  return result.ok ? result.data.fundingRounds : [];
}

async function fetchExistingInvestments(entityId: string): Promise<InvestmentRecord[]> {
  const result = await apiRequest<{ investments: InvestmentRecord[] }>(
    'GET',
    `/api/investments/by-entity/${encodeURIComponent(entityId)}?limit=200`,
  );
  return result.ok ? result.data.investments : [];
}

async function fetchExistingBenchmarkResults(modelId: string): Promise<BenchmarkResultRecord[]> {
  const result = await apiRequest<{ benchmarkResults: BenchmarkResultRecord[] }>(
    'GET',
    `/api/benchmark-results/by-model/${encodeURIComponent(modelId)}?limit=200`,
  );
  return result.ok ? result.data.benchmarkResults : [];
}

async function fetchExistingGrantsForOrg(entityId: string): Promise<GrantRecord[]> {
  const result = await apiRequest<{ grants: GrantRecord[] }>(
    'GET',
    `/api/grants/by-entity/${encodeURIComponent(entityId)}?limit=200`,
  );
  return result.ok ? result.data.grants : [];
}

// ---------------------------------------------------------------------------
// Dedup logic
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Dedup personnel records. Match on personId + organizationId + role. */
export async function dedupPersonnel(
  entityId: string,
  candidates: PersonnelRecord[],
): Promise<PersonnelRecord[]> {
  const existing = await fetchExistingPersonnel(entityId);
  const keys = new Set(
    existing.map(r => `${normalize(r.personId)}|${normalize(r.organizationId)}|${normalize(r.role)}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.personId)}|${normalize(c.organizationId)}|${normalize(c.role)}`),
  );
}

/** Dedup funding rounds. Match on companyId + name. */
export async function dedupFundingRounds(
  entityId: string,
  candidates: FundingRoundRecord[],
): Promise<FundingRoundRecord[]> {
  const existing = await fetchExistingFundingRounds(entityId);
  const keys = new Set(
    existing.map(r => `${normalize(r.companyId)}|${normalize(r.name)}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.companyId)}|${normalize(c.name)}`),
  );
}

/** Dedup investments. Match on companyId + investorId + roundName. */
export async function dedupInvestments(
  entityId: string,
  candidates: InvestmentRecord[],
): Promise<InvestmentRecord[]> {
  const existing = await fetchExistingInvestments(entityId);
  const keys = new Set(
    existing.map(r => `${normalize(r.companyId)}|${normalize(r.investorId)}|${normalize(r.roundName || '')}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.companyId)}|${normalize(c.investorId)}|${normalize(c.roundName || '')}`),
  );
}

/** Dedup benchmark results. Match on benchmarkId + modelId. */
export async function dedupBenchmarkResults(
  modelId: string,
  candidates: BenchmarkResultRecord[],
): Promise<BenchmarkResultRecord[]> {
  const existing = await fetchExistingBenchmarkResults(modelId);
  const keys = new Set(
    existing.map(r => `${normalize(r.benchmarkId)}|${normalize(r.modelId)}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.benchmarkId)}|${normalize(c.modelId)}`),
  );
}

/** Get grants for an org that are missing granteeId */
export async function getUnlinkedGrants(entityId: string): Promise<GrantRecord[]> {
  const grants = await fetchExistingGrantsForOrg(entityId);
  return grants.filter(g => !g.granteeId);
}
