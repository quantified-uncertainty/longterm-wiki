/**
 * TableBase Scanner
 *
 * Queries wiki-server API endpoints to compute per-entity completeness metrics
 * for structured data tables (grants, personnel, funding rounds, investments,
 * benchmark results).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { TableProfile, TableScanResult, ScanSummary } from './types.ts';

// ---------------------------------------------------------------------------
// Entity importance from database.json (page rankings)
// ---------------------------------------------------------------------------

interface PageData {
  id: string;
  wikiId?: string;
  readerImportance?: number | null;
}

let _importanceMap: Map<string, number> | null = null;

function getImportanceMap(): Map<string, number> {
  if (_importanceMap) return _importanceMap;
  _importanceMap = new Map();
  const dbPath = join(PROJECT_ROOT, 'apps/web/src/data/database.json');
  if (!existsSync(dbPath)) return _importanceMap;
  try {
    const db = JSON.parse(readFileSync(dbPath, 'utf-8'));
    for (const page of (db.pages || []) as PageData[]) {
      if (page.readerImportance != null) {
        _importanceMap.set(page.id, page.readerImportance);
        if (page.wikiId) _importanceMap.set(page.wikiId, page.readerImportance);
      }
    }
  } catch {
    // Non-critical — importance is optional
  }
  return _importanceMap;
}

function lookupImportance(entitySlugOrId: string): number | undefined {
  return getImportanceMap().get(entitySlugOrId);
}

// ---------------------------------------------------------------------------
// API response shapes (minimal — just what we need for scanning)
// ---------------------------------------------------------------------------

interface EntityListResponse {
  entities: Array<{
    id: string;
    wikiId?: string;
    stableId?: string;
    entityType: string;
    title: string;
    website?: string;
  }>;
  total: number;
}

interface GrantOrgSummary {
  organizations: Array<{
    organizationId: string;
    grantCount: number;
    totalAmount: number | null;
  }>;
}

interface GrantAllResponse {
  grants: Array<{
    id: string;
    organizationId: string;
    granteeId: string | null;
    name: string;
  }>;
  total: number;
}

interface PersonnelAllResponse {
  personnel: Array<{
    id: string;
    personId: string;
    organizationId: string;
    role: string;
    roleType: string;
  }>;
  total: number;
}

interface FundingRoundsAllResponse {
  fundingRounds: Array<{
    id: string;
    companyId: string;
    name: string;
  }>;
  total: number;
}

interface InvestmentsAllResponse {
  investments: Array<{
    id: string;
    companyId: string;
    investorId: string;
  }>;
  total: number;
}

interface BenchmarkResultsAllResponse {
  benchmarkResults: Array<{
    id: string;
    benchmarkId: string;
    modelId: string;
    score: number | null;
  }>;
  total?: number;
}

interface StatsResponse {
  total: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Paginated fetch helper
// ---------------------------------------------------------------------------

async function fetchAllPaginated<T>(
  path: string,
  resultKey: string,
  pageSize = 200,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await apiRequest<Record<string, unknown>>(
      'GET',
      `${path}${separator}limit=${pageSize}&offset=${offset}`,
    );
    if (!result.ok) {
      console.warn(`[tablebase] Failed to fetch ${path}: ${result.message}`);
      break;
    }
    const data = result.data;
    const page = (data[resultKey] as T[]) || [];
    items.push(...page);
    total = (data.total as number) ?? page.length;
    offset += pageSize;
    if (page.length < pageSize) break;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Entity fetching
// ---------------------------------------------------------------------------

async function fetchEntitiesByType(entityType: string): Promise<EntityListResponse['entities']> {
  return fetchAllPaginated<EntityListResponse['entities'][number]>(
    `/api/entities?entityType=${encodeURIComponent(entityType)}`,
    'entities',
    500,
  );
}

// ---------------------------------------------------------------------------
// Per-table scanners
// ---------------------------------------------------------------------------

async function scanGrantCompleteness(): Promise<TableScanResult> {
  // Get org-level summary
  const summaryResult = await apiRequest<GrantOrgSummary>('GET', '/api/grants/by-org-summary');
  const orgs = summaryResult.ok ? summaryResult.data.organizations : [];

  // Get all grants to check granteeId linkage
  const allGrants = await fetchAllPaginated<GrantAllResponse['grants'][number]>(
    '/api/grants/all',
    'grants',
  );

  // Build per-org profiles
  const orgEntities = await fetchEntitiesByType('organization');
  const orgMap = new Map(orgEntities.map(e => [e.stableId || e.id, e]));

  // Group grants by org
  const grantsByOrg = new Map<string, typeof allGrants>();
  for (const g of allGrants) {
    const arr = grantsByOrg.get(g.organizationId) || [];
    arr.push(g);
    grantsByOrg.set(g.organizationId, arr);
  }

  const profiles: TableProfile[] = [];
  const orgSummaryMap = new Map(orgs.map(o => [o.organizationId, o]));

  for (const [orgId, entity] of orgMap) {
    const summary = orgSummaryMap.get(orgId);
    const orgGrants = grantsByOrg.get(orgId) || [];
    const grantCount = summary?.grantCount ?? orgGrants.length;

    if (grantCount === 0) continue; // Only profile orgs that give grants

    const linkedCount = orgGrants.filter(g => g.granteeId).length;
    const completeness = grantCount > 0 ? Math.round((linkedCount / grantCount) * 100) : 100;
    const missing: string[] = [];
    if (linkedCount < grantCount) {
      missing.push(`${grantCount - linkedCount} grants missing granteeId`);
    }

    profiles.push({
      entityId: orgId,
      entityName: entity.title,
      entityType: 'organization',
      table: 'grants',
      totalRecords: grantCount,
      completenessPercent: completeness,
      missingFields: missing,
    });
  }

  const statsResult = await apiRequest<StatsResponse>('GET', '/api/grants/stats');
  const totalRecords = statsResult.ok ? statsResult.data.total : allGrants.length;

  return {
    table: 'grants',
    totalEntities: profiles.length,
    entitiesWithRecords: profiles.filter(p => p.totalRecords > 0).length,
    totalRecords,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 100,
    profiles,
  };
}

async function scanPersonnelCompleteness(): Promise<TableScanResult> {
  const allPersonnel = await fetchAllPaginated<PersonnelAllResponse['personnel'][number]>(
    '/api/personnel/all',
    'personnel',
  );

  const orgEntities = await fetchEntitiesByType('organization');

  // Group by org
  const byOrg = new Map<string, number>();
  for (const p of allPersonnel) {
    byOrg.set(p.organizationId, (byOrg.get(p.organizationId) || 0) + 1);
  }

  const profiles: TableProfile[] = orgEntities.map(entity => {
    const orgId = entity.stableId || entity.id;
    const count = byOrg.get(orgId) || 0;
    const completeness = count > 0 ? Math.min(100, count * 20) : 0; // 5+ records = 100%
    const missing: string[] = [];
    if (count === 0) missing.push('no personnel records');
    else if (count < 3) missing.push(`only ${count} personnel records`);

    return {
      entityId: orgId,
      entityName: entity.title,
      entityType: 'organization',
      table: 'personnel',
      totalRecords: count,
      completenessPercent: completeness,
      missingFields: missing,
      website: entity.website,
      entityImportance: lookupImportance(entity.id) ?? lookupImportance(entity.wikiId || ''),
    };
  });

  return {
    table: 'personnel',
    totalEntities: orgEntities.length,
    entitiesWithRecords: profiles.filter(p => p.totalRecords > 0).length,
    totalRecords: allPersonnel.length,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 0,
    profiles,
  };
}

async function scanFundingRoundsCompleteness(): Promise<TableScanResult> {
  const allRounds = await fetchAllPaginated<FundingRoundsAllResponse['fundingRounds'][number]>(
    '/api/funding-rounds/all',
    'fundingRounds',
  );

  const orgEntities = await fetchEntitiesByType('organization');

  const byCompany = new Map<string, number>();
  for (const r of allRounds) {
    byCompany.set(r.companyId, (byCompany.get(r.companyId) || 0) + 1);
  }

  const profiles: TableProfile[] = orgEntities.map(entity => {
    const id = entity.stableId || entity.id;
    const count = byCompany.get(id) || 0;
    // Not all orgs have funding rounds; completeness is binary here
    const completeness = count > 0 ? 100 : 0;
    const missing: string[] = [];
    if (count === 0) missing.push('no funding round data');

    return {
      entityId: id,
      entityName: entity.title,
      entityType: 'organization',
      table: 'funding_rounds',
      totalRecords: count,
      completenessPercent: completeness,
      missingFields: missing,
      website: entity.website,
      entityImportance: lookupImportance(entity.id) ?? lookupImportance(entity.wikiId || ''),
    };
  });

  return {
    table: 'funding_rounds',
    totalEntities: orgEntities.length,
    entitiesWithRecords: profiles.filter(p => p.totalRecords > 0).length,
    totalRecords: allRounds.length,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 0,
    profiles,
  };
}

async function scanInvestmentsCompleteness(): Promise<TableScanResult> {
  const allInvestments = await fetchAllPaginated<InvestmentsAllResponse['investments'][number]>(
    '/api/investments/all',
    'investments',
  );

  const orgEntities = await fetchEntitiesByType('organization');

  const byCompany = new Map<string, number>();
  for (const inv of allInvestments) {
    byCompany.set(inv.companyId, (byCompany.get(inv.companyId) || 0) + 1);
  }

  const profiles: TableProfile[] = orgEntities.map(entity => {
    const id = entity.stableId || entity.id;
    const count = byCompany.get(id) || 0;
    const completeness = count > 0 ? 100 : 0;
    const missing: string[] = [];
    if (count === 0) missing.push('no investment records');

    return {
      entityId: id,
      entityName: entity.title,
      entityType: 'organization',
      table: 'investments',
      totalRecords: count,
      completenessPercent: completeness,
      missingFields: missing,
      website: entity.website,
      entityImportance: lookupImportance(entity.id) ?? lookupImportance(entity.wikiId || ''),
    };
  });

  return {
    table: 'investments',
    totalEntities: orgEntities.length,
    entitiesWithRecords: profiles.filter(p => p.totalRecords > 0).length,
    totalRecords: allInvestments.length,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 0,
    profiles,
  };
}

async function scanBenchmarkResultsCompleteness(): Promise<TableScanResult> {
  const allResults = await fetchAllPaginated<BenchmarkResultsAllResponse['benchmarkResults'][number]>(
    '/api/benchmark-results/all',
    'benchmarkResults',
  );

  const modelEntities = await fetchEntitiesByType('ai-model');

  const byModel = new Map<string, number>();
  for (const r of allResults) {
    byModel.set(r.modelId, (byModel.get(r.modelId) || 0) + 1);
  }

  const profiles: TableProfile[] = modelEntities.map(entity => {
    const id = entity.stableId || entity.id;
    const count = byModel.get(id) || 0;
    // More benchmarks = more complete. 10+ = 100%
    const completeness = count > 0 ? Math.min(100, count * 10) : 0;
    const missing: string[] = [];
    if (count === 0) missing.push('no benchmark results');
    else if (count < 5) missing.push(`only ${count} benchmark results`);

    return {
      entityId: id,
      entityName: entity.title,
      entityType: 'ai-model',
      table: 'benchmark_results',
      totalRecords: count,
      completenessPercent: completeness,
      missingFields: missing,
      website: entity.website,
      entityImportance: lookupImportance(entity.id) ?? lookupImportance(entity.wikiId || ''),
    };
  });

  return {
    table: 'benchmark_results',
    totalEntities: modelEntities.length,
    entitiesWithRecords: profiles.filter(p => p.totalRecords > 0).length,
    totalRecords: allResults.length,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 0,
    profiles,
  };
}

// ---------------------------------------------------------------------------
// Full scan
// ---------------------------------------------------------------------------

export async function runFullScan(): Promise<ScanSummary> {
  const [grants, personnel, fundingRounds, investments, benchmarkResults] = await Promise.all([
    scanGrantCompleteness(),
    scanPersonnelCompleteness(),
    scanFundingRoundsCompleteness(),
    scanInvestmentsCompleteness(),
    scanBenchmarkResultsCompleteness(),
  ]);

  return {
    tables: [grants, personnel, fundingRounds, investments, benchmarkResults],
    timestamp: new Date().toISOString(),
  };
}

export async function runTableScan(table: string): Promise<TableScanResult | null> {
  switch (table) {
    case 'grants': return scanGrantCompleteness();
    case 'personnel': return scanPersonnelCompleteness();
    case 'funding_rounds': case 'funding-rounds': return scanFundingRoundsCompleteness();
    case 'investments': return scanInvestmentsCompleteness();
    case 'benchmark_results': case 'benchmark-results': return scanBenchmarkResultsCompleteness();
    default: return null;
  }
}
