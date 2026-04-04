/**
 * TableBase Dedup
 *
 * Pre-submit deduplication against existing records.
 * Queries the wiki-server for current records and filters out duplicates.
 */

import { getPersonnelByEntity } from '../lib/wiki-server/personnel.ts';
import { getFundingRoundsByEntity } from '../lib/wiki-server/funding-rounds.ts';
import { getInvestmentsByEntity } from '../lib/wiki-server/investments.ts';
import { getBenchmarkResultsByModel, type BenchmarkResultEntry } from '../lib/wiki-server/benchmark-results.ts';
import { getFundingProgramsByOrg } from '../lib/wiki-server/funding-programs.ts';
import { getGrantsByEntity } from '../lib/wiki-server/grants.ts';




// ---------------------------------------------------------------------------
// Fetch existing records for an entity
// ---------------------------------------------------------------------------

async function fetchExistingPersonnel(entityId: string) {
  const result = await getPersonnelByEntity(entityId, { limit: 200 });
  return result.ok ? result.data.personnel : [];
}

async function fetchExistingFundingRounds(entityId: string) {
  const result = await getFundingRoundsByEntity(entityId, { limit: 200 });
  return result.ok ? result.data.fundingRounds : [];
}

async function fetchExistingInvestments(entityId: string) {
  const result = await getInvestmentsByEntity(entityId, { limit: 200 });
  return result.ok ? result.data.investments : [];
}

async function fetchExistingBenchmarkResults(modelId: string): Promise<BenchmarkResultEntry[]> {
  const result = await getBenchmarkResultsByModel(modelId, { limit: 200 });
  return result.ok ? result.data.benchmarkResults : [];
}

async function fetchExistingFundingPrograms(orgId: string) {
  const result = await getFundingProgramsByOrg(orgId, { limit: 500 });
  return result.ok ? result.data.fundingPrograms : [];
}

async function fetchExistingGrantsForOrg(entityId: string) {
  const result = await getGrantsByEntity(entityId, { limit: 200 });
  return result.ok ? result.data.grants : [];
}

// ---------------------------------------------------------------------------
// Dedup logic
// ---------------------------------------------------------------------------

function normalize(s: unknown): string {
  return (typeof s === 'string' ? s : '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Dedup personnel records. Match on personId + organizationId + role. */
export async function dedupPersonnel(
  entityId: string,
  candidates: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
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
  candidates: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
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
  candidates: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const existing = await fetchExistingInvestments(entityId);
  const keys = new Set(
    existing.map(r => `${normalize(r.companyId)}|${normalize(r.investorId)}|${normalize(r.roundName)}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.companyId)}|${normalize(c.investorId)}|${normalize(c.roundName)}`),
  );
}

/** Dedup benchmark results. Match on benchmarkId + modelId. */
export async function dedupBenchmarkResults(
  modelId: string,
  candidates: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const existing = await fetchExistingBenchmarkResults(modelId);
  const keys = new Set(
    existing.map(r => `${normalize(r.benchmarkId)}|${normalize(r.modelId)}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.benchmarkId)}|${normalize(c.modelId)}`),
  );
}

/** Dedup funding programs. Match on orgId + name (case-insensitive). */
export async function dedupFundingPrograms(
  orgId: string,
  candidates: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const existing = await fetchExistingFundingPrograms(orgId);
  const keys = new Set(
    existing.map(r => `${normalize(r.orgId)}|${normalize(r.name)}`),
  );
  return candidates.filter(
    c => !keys.has(`${normalize(c.orgId)}|${normalize(c.name)}`),
  );
}

/** Get grants for an org that are missing granteeId */
export async function getUnlinkedGrants(entityId: string) {
  const grants = await fetchExistingGrantsForOrg(entityId);
  return grants.filter(g => !g.granteeId);
}
