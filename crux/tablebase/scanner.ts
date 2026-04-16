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
import type { TableProfile, TableScanResult, ScanSummary, FieldGapStat, FieldGapReport } from './types.ts';

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
    sourceUrl: string | null;
  }>;
  total?: number;
}

interface DivisionsAllResponse {
  divisions: Array<{
    id: string;
    parentOrgId: string;
    name: string;
    lead: string | null;
    status: string | null;
  }>;
  total: number;
}

interface DivisionPersonnelAllResponse {
  divisionPersonnel: Array<{
    id: string;
    divisionId: string;
    personId: string;
    role: string;
    startDate: string | null;
    endDate: string | null;
  }>;
  total: number;
}

interface FundingProgramsAllResponse {
  fundingPrograms: Array<{
    id: string;
    orgId: string;
    name: string;
    totalBudget: number | null;
    applicationUrl: string | null;
    deadline: string | null;
    status: string | null;
  }>;
  total: number;
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
    total = (data.total as number) ?? Infinity;
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

async function scanGrantCompleteness(prefetchedOrgs?: EntityListResponse['entities']): Promise<TableScanResult> {
  // Get org-level summary
  const summaryResult = await apiRequest<GrantOrgSummary>('GET', '/api/grants/by-org-summary');
  const orgs = summaryResult.ok ? summaryResult.data.organizations : [];

  // Get all grants to check granteeId linkage
  const allGrants = await fetchAllPaginated<GrantAllResponse['grants'][number]>(
    '/api/grants/all',
    'grants',
  );

  // Build per-org profiles
  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');
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

async function scanPersonnelCompleteness(prefetchedOrgs?: EntityListResponse['entities']): Promise<TableScanResult> {
  const allPersonnel = await fetchAllPaginated<PersonnelAllResponse['personnel'][number]>(
    '/api/personnel/all',
    'personnel',
  );

  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');

  // Group by org
  const byOrg = new Map<string, number>();
  for (const p of allPersonnel) {
    byOrg.set(p.organizationId, (byOrg.get(p.organizationId) || 0) + 1);
  }

  const profiles: TableProfile[] = orgEntities.map(entity => {
    const orgId = entity.stableId || entity.id;
    const count = byOrg.get(orgId) || 0;
    const completeness = count > 0 ? Math.min(100, count * 5) : 0; // 20+ records = 100%
    const missing: string[] = [];
    if (count === 0) missing.push('no personnel records');
    else if (count < 5) missing.push(`only ${count} personnel records — missing broader team`);
    else if (count < 15) missing.push(`${count} personnel records — deeper coverage needed`);

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

async function scanFundingRoundsCompleteness(prefetchedOrgs?: EntityListResponse['entities']): Promise<TableScanResult> {
  const allRounds = await fetchAllPaginated<FundingRoundsAllResponse['fundingRounds'][number]>(
    '/api/funding-rounds/all',
    'fundingRounds',
  );

  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');

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

async function scanInvestmentsCompleteness(prefetchedOrgs?: EntityListResponse['entities']): Promise<TableScanResult> {
  const allInvestments = await fetchAllPaginated<InvestmentsAllResponse['investments'][number]>(
    '/api/investments/all',
    'investments',
  );

  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');

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

async function scanBenchmarkResultsCompleteness(prefetchedModels?: EntityListResponse['entities']): Promise<TableScanResult> {
  const allResults = await fetchAllPaginated<BenchmarkResultsAllResponse['benchmarkResults'][number]>(
    '/api/benchmark-results/all',
    'benchmarkResults',
  );

  const modelEntities = prefetchedModels ?? await fetchEntitiesByType('ai-model');

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
// Field-level completeness scanners (QUA-24)
//
// Unlike count-based scanners above, these score entities by the fill rate of
// specific fields within existing records. Use them to surface structural gaps
// that the `tb tablebase improve` agent can then enrich field-by-field.
// ---------------------------------------------------------------------------

function buildScanResult(table: string, totalRecords: number, profiles: TableProfile[]): TableScanResult {
  return {
    table,
    totalEntities: profiles.length,
    entitiesWithRecords: profiles.length,
    totalRecords,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 100,
    profiles,
  };
}

function buildProfile(
  entity: EntityListResponse['entities'][number],
  table: string,
  entityType: 'organization' | 'ai-model',
  totalRecords: number,
  completenessPercent: number,
  missingFields: string[],
): TableProfile {
  return {
    entityId: entity.stableId || entity.id,
    entityName: entity.title,
    entityType,
    table,
    totalRecords,
    completenessPercent,
    missingFields,
    website: entity.website,
    entityImportance: lookupImportance(entity.id) ?? lookupImportance(entity.wikiId || ''),
  };
}

type Division = DivisionsAllResponse['divisions'][number];

async function fetchAllDivisions(): Promise<Division[]> {
  return fetchAllPaginated<Division>('/api/divisions/all', 'divisions');
}

async function scanDivisionsLead(
  prefetchedOrgs?: EntityListResponse['entities'],
  prefetchedDivisions?: Division[],
): Promise<TableScanResult> {
  const allDivisions = prefetchedDivisions ?? await fetchAllDivisions();
  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');

  // Group divisions by parent org. Skip inactive divisions — no point researching leads for defunct ones.
  const byOrg = new Map<string, { total: number; withLead: number }>();
  for (const d of allDivisions) {
    if (d.status === 'inactive' || d.status === 'dissolved') continue;
    const bucket = byOrg.get(d.parentOrgId) ?? { total: 0, withLead: 0 };
    bucket.total += 1;
    if (d.lead && d.lead.trim().length > 0) bucket.withLead += 1;
    byOrg.set(d.parentOrgId, bucket);
  }

  const profiles: TableProfile[] = [];
  for (const entity of orgEntities) {
    const bucket = byOrg.get(entity.stableId || entity.id);
    if (!bucket || bucket.total === 0) continue;
    const completeness = Math.round((bucket.withLead / bucket.total) * 100);
    const gap = bucket.total - bucket.withLead;
    const missing = gap > 0 ? [`${gap} of ${bucket.total} divisions missing lead`] : [];
    profiles.push(buildProfile(entity, 'divisions', 'organization', bucket.total, completeness, missing));
  }

  return buildScanResult('divisions', allDivisions.length, profiles);
}

async function scanDivisionPersonnelDates(
  prefetchedOrgs?: EntityListResponse['entities'],
  prefetchedDivisions?: Division[],
): Promise<TableScanResult> {
  const [allDivisions, allPersonnel] = await Promise.all([
    prefetchedDivisions ? Promise.resolve(prefetchedDivisions) : fetchAllDivisions(),
    fetchAllPaginated<DivisionPersonnelAllResponse['divisionPersonnel'][number]>(
      '/api/division-personnel/all',
      'divisionPersonnel',
    ),
  ]);

  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');

  // divisionId → parentOrgId
  const divisionToOrg = new Map<string, string>();
  for (const d of allDivisions) divisionToOrg.set(d.id, d.parentOrgId);

  // Group personnel by parent org (via their division). Only startDate drives
  // the score — endDate is legitimately null for current roles.
  const byOrg = new Map<string, { total: number; withStart: number }>();
  for (const p of allPersonnel) {
    const orgId = divisionToOrg.get(p.divisionId);
    if (!orgId) continue;
    const bucket = byOrg.get(orgId) ?? { total: 0, withStart: 0 };
    bucket.total += 1;
    if (p.startDate) bucket.withStart += 1;
    byOrg.set(orgId, bucket);
  }

  const profiles: TableProfile[] = [];
  for (const entity of orgEntities) {
    const bucket = byOrg.get(entity.stableId || entity.id);
    if (!bucket || bucket.total === 0) continue;
    const completeness = Math.round((bucket.withStart / bucket.total) * 100);
    const gap = bucket.total - bucket.withStart;
    const missing = gap > 0 ? [`${gap} of ${bucket.total} division personnel missing startDate`] : [];
    profiles.push(buildProfile(entity, 'division_personnel', 'organization', bucket.total, completeness, missing));
  }

  return buildScanResult('division_personnel', allPersonnel.length, profiles);
}

async function scanFundingProgramFields(prefetchedOrgs?: EntityListResponse['entities']): Promise<TableScanResult> {
  const allPrograms = await fetchAllPaginated<FundingProgramsAllResponse['fundingPrograms'][number]>(
    '/api/funding-programs/all',
    'fundingPrograms',
  );

  const orgEntities = prefetchedOrgs ?? await fetchEntitiesByType('organization');

  // Group by offering org; count fill rate across the three target fields.
  // Only 'open' programs need deadline/applicationUrl enrichment — 'closed' and
  // 'awarded' are historical and those fields are no longer actionable.
  // schema.ts:2373 → status enum is: open | closed | awarded.
  const byOrg = new Map<string, { total: number; slots: number; filled: number; gaps: { budget: number; deadline: number; url: number } }>();
  for (const p of allPrograms) {
    const isActive = p.status === 'open';
    const bucket = byOrg.get(p.orgId) ?? { total: 0, slots: 0, filled: 0, gaps: { budget: 0, deadline: 0, url: 0 } };
    bucket.total += 1;
    // totalBudget is always expected
    bucket.slots += 1;
    if (p.totalBudget != null) bucket.filled += 1; else bucket.gaps.budget += 1;
    if (isActive) {
      bucket.slots += 2;
      if (p.deadline) bucket.filled += 1; else bucket.gaps.deadline += 1;
      if (p.applicationUrl) bucket.filled += 1; else bucket.gaps.url += 1;
    }
    byOrg.set(p.orgId, bucket);
  }

  const profiles: TableProfile[] = [];
  for (const entity of orgEntities) {
    const bucket = byOrg.get(entity.stableId || entity.id);
    if (!bucket || bucket.slots === 0) continue;
    const completeness = Math.round((bucket.filled / bucket.slots) * 100);
    const missing: string[] = [];
    if (bucket.gaps.budget > 0) missing.push(`${bucket.gaps.budget} programs missing totalBudget`);
    if (bucket.gaps.deadline > 0) missing.push(`${bucket.gaps.deadline} active programs missing deadline`);
    if (bucket.gaps.url > 0) missing.push(`${bucket.gaps.url} active programs missing applicationUrl`);
    profiles.push(buildProfile(entity, 'funding_programs', 'organization', bucket.total, completeness, missing));
  }

  return buildScanResult('funding_programs', allPrograms.length, profiles);
}

async function scanBenchmarkResultSources(prefetchedModels?: EntityListResponse['entities']): Promise<TableScanResult> {
  const allResults = await fetchAllPaginated<BenchmarkResultsAllResponse['benchmarkResults'][number]>(
    '/api/benchmark-results/all',
    'benchmarkResults',
  );

  const modelEntities = prefetchedModels ?? await fetchEntitiesByType('ai-model');

  const byModel = new Map<string, { total: number; withSource: number }>();
  for (const r of allResults) {
    const bucket = byModel.get(r.modelId) ?? { total: 0, withSource: 0 };
    bucket.total += 1;
    if (r.sourceUrl && r.sourceUrl.trim().length > 0) bucket.withSource += 1;
    byModel.set(r.modelId, bucket);
  }

  const profiles: TableProfile[] = [];
  for (const entity of modelEntities) {
    const bucket = byModel.get(entity.stableId || entity.id);
    if (!bucket || bucket.total === 0) continue;
    const completeness = Math.round((bucket.withSource / bucket.total) * 100);
    const gap = bucket.total - bucket.withSource;
    const missing = gap > 0 ? [`${gap} of ${bucket.total} benchmark results missing sourceUrl`] : [];
    profiles.push(buildProfile(entity, 'benchmark_result_sources', 'ai-model', bucket.total, completeness, missing));
  }

  return buildScanResult('benchmark_result_sources', allResults.length, profiles);
}

// ---------------------------------------------------------------------------
// Source quality scanner (unverifiable verdicts)
// ---------------------------------------------------------------------------

interface VerdictRow {
  recordType: string;
  recordId: string;
  entityId: string | null;
  displayName: string | null;
  entityDisplayName: string | null;
  verdict: string;
  reasoning: string | null;
}

async function scanSourceQuality(): Promise<TableScanResult> {
  // Fetch all unverifiable verdicts from the sourcing API
  const allVerdicts: VerdictRow[] = [];
  let offset = 0;
  const pageSize = 200;

  while (true) {
    const result = await apiRequest<{ verdicts: VerdictRow[]; total: number }>(
      'GET',
      `/api/sourcing/verdicts?verdict=unverifiable&limit=${pageSize}&offset=${offset}`,
    );
    if (!result.ok) {
      console.warn(`[tablebase] Failed to fetch unverifiable verdicts: ${result.message}`);
      break;
    }
    allVerdicts.push(...result.data.verdicts);
    if (allVerdicts.length >= result.data.total || result.data.verdicts.length < pageSize) break;
    offset += pageSize;
  }

  if (allVerdicts.length === 0) {
    return {
      table: 'source_quality',
      totalEntities: 0,
      entitiesWithRecords: 0,
      totalRecords: 0,
      avgCompleteness: 100,
      profiles: [],
    };
  }

  // Group by entityId
  const byEntity = new Map<string, { count: number; displayName: string | null; entityType: string | null }>();
  for (const v of allVerdicts) {
    if (!v.entityId) continue;
    const existing = byEntity.get(v.entityId);
    if (existing) {
      existing.count++;
      // Prefer non-null display names
      if (!existing.displayName && v.entityDisplayName) {
        existing.displayName = v.entityDisplayName;
      }
    } else {
      byEntity.set(v.entityId, { count: 1, displayName: v.entityDisplayName, entityType: null });
    }
  }

  // Resolve missing entity names and entity types from the entities API
  // Entity type is always missing (verdicts don't carry it), so look up all entities.
  // This also fills in missing display names.
  for (const [entityId, entry] of byEntity) {
    const entityResult = await apiRequest<{ id: string; title: string; entityType: string }>(
      'GET',
      `/api/entities/${encodeURIComponent(entityId)}`,
    );
    if (entityResult.ok) {
      if (!entry.displayName && entityResult.data.title) {
        entry.displayName = entityResult.data.title;
      }
      if (entityResult.data.entityType) {
        entry.entityType = entityResult.data.entityType;
      }
    }
  }

  const profiles: TableProfile[] = [];
  for (const [entityId, { count, displayName, entityType }] of byEntity) {
    // More unverifiable records = lower "completeness" (used as the gap signal)
    // Cap at 20 — beyond that it's all high-priority (20 × 5 = 100)
    const completeness = Math.max(0, 100 - count * 5);

    profiles.push({
      entityId,
      entityName: displayName || entityId,
      entityType: entityType || 'organization',
      table: 'source_quality',
      totalRecords: count,
      completenessPercent: completeness,
      missingFields: [`${count} record(s) with unverifiable sources`],
      entityImportance: lookupImportance(entityId),
    });
  }

  return {
    table: 'source_quality',
    totalEntities: profiles.length,
    entitiesWithRecords: profiles.length,
    totalRecords: allVerdicts.length,
    avgCompleteness: profiles.length > 0
      ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
      : 100,
    profiles,
  };
}

// ---------------------------------------------------------------------------
// Full scan
// ---------------------------------------------------------------------------

export async function runFullScan(): Promise<ScanSummary> {
  // Fetch shared data once; scans share both entity lists and the divisions
  // list (used by both divisions-lead and division-personnel scanners).
  const [orgEntities, modelEntities, allDivisions] = await Promise.all([
    fetchEntitiesByType('organization'),
    fetchEntitiesByType('ai-model'),
    fetchAllDivisions(),
  ]);

  const [
    grants,
    personnel,
    fundingRounds,
    investments,
    benchmarkResults,
    divisionsLead,
    divisionPersonnelDates,
    fundingProgramFields,
    benchmarkResultSources,
    sourceQuality,
  ] = await Promise.all([
    scanGrantCompleteness(orgEntities),
    scanPersonnelCompleteness(orgEntities),
    scanFundingRoundsCompleteness(orgEntities),
    scanInvestmentsCompleteness(orgEntities),
    scanBenchmarkResultsCompleteness(modelEntities),
    scanDivisionsLead(orgEntities, allDivisions),
    scanDivisionPersonnelDates(orgEntities, allDivisions),
    scanFundingProgramFields(orgEntities),
    scanBenchmarkResultSources(modelEntities),
    scanSourceQuality().catch((e: unknown) => {
      // Source quality scanning is best-effort — wiki-server may not have sourcing data
      console.warn(`[tablebase] Source quality scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return { table: 'source_quality', totalEntities: 0, entitiesWithRecords: 0, totalRecords: 0, avgCompleteness: 100, profiles: [] } as TableScanResult;
    }),
  ]);

  return {
    tables: [
      grants,
      personnel,
      fundingRounds,
      investments,
      benchmarkResults,
      divisionsLead,
      divisionPersonnelDates,
      fundingProgramFields,
      benchmarkResultSources,
      sourceQuality,
    ],
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Field-gap profiler (QUA-551)
//
// Profiles null / empty-string / "n/a" rates for every enrichable field on a
// table, sorted by combined gap rate. Output is consumed by the improve
// pipeline to target field-by-field enrichment work.
// ---------------------------------------------------------------------------

interface FieldConfig {
  field: string;
  /** Declared type — for reporting only. We don't coerce values. */
  columnType: 'string' | 'number' | 'date' | 'url' | 'enum' | 'boolean' | 'id';
}

/**
 * Which fields to profile for each table. Excludes identity columns (id,
 * natural-key FKs, name) and timestamps — those are never "enrichable" gaps.
 * Derived from the wiki-server `formatRow` shapes in each tablebase route.
 */
const FIELD_GAP_CONFIGS: Record<string, FieldConfig[]> = {
  divisions: [
    { field: 'divisionType', columnType: 'enum' },
    { field: 'lead', columnType: 'id' },
    { field: 'status', columnType: 'enum' },
    { field: 'startDate', columnType: 'date' },
    { field: 'endDate', columnType: 'date' },
    { field: 'website', columnType: 'url' },
    { field: 'source', columnType: 'string' },
    { field: 'notes', columnType: 'string' },
  ],
  division_personnel: [
    { field: 'role', columnType: 'string' },
    { field: 'startDate', columnType: 'date' },
    { field: 'endDate', columnType: 'date' },
    { field: 'source', columnType: 'string' },
    { field: 'notes', columnType: 'string' },
  ],
  funding_programs: [
    { field: 'divisionId', columnType: 'id' },
    { field: 'description', columnType: 'string' },
    { field: 'programType', columnType: 'enum' },
    { field: 'totalBudget', columnType: 'number' },
    { field: 'currency', columnType: 'enum' },
    { field: 'applicationUrl', columnType: 'url' },
    { field: 'openDate', columnType: 'date' },
    { field: 'deadline', columnType: 'date' },
    { field: 'status', columnType: 'enum' },
    { field: 'source', columnType: 'string' },
    { field: 'notes', columnType: 'string' },
  ],
  benchmark_results: [
    { field: 'score', columnType: 'number' },
    { field: 'unit', columnType: 'enum' },
    { field: 'date', columnType: 'date' },
    { field: 'sourceUrl', columnType: 'url' },
    { field: 'notes', columnType: 'string' },
  ],
};

const NA_PATTERN = /^(n\/a|na)$/i;

type FieldValueClass = 'null' | 'empty' | 'na' | 'filled';

function classifyValue(value: unknown): FieldValueClass {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 'empty';
    if (NA_PATTERN.test(trimmed)) return 'na';
    return 'filled';
  }
  // Numeric 0 and boolean false are legitimate values, not gaps.
  return 'filled';
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 1000) / 10; // one decimal place
}

export function profileFields<T extends { id: string }>(
  table: string,
  rows: T[],
  configs: FieldConfig[],
): FieldGapReport {
  const stats: FieldGapStat[] = configs.map(({ field, columnType }) => {
    let nullCount = 0;
    let emptyCount = 0;
    let naCount = 0;
    const sampleMissingRows: string[] = [];

    for (const row of rows) {
      const cls = classifyValue((row as Record<string, unknown>)[field]);
      if (cls === 'filled') continue;
      if (cls === 'null') nullCount += 1;
      else if (cls === 'empty') emptyCount += 1;
      else if (cls === 'na') naCount += 1;
      if (sampleMissingRows.length < 3) sampleMissingRows.push(row.id);
    }

    const total = rows.length;
    const nullPct = pct(nullCount, total);
    const emptyPct = pct(emptyCount, total);
    const naPct = pct(naCount, total);
    const gapPct = Math.min(100, Math.round((nullPct + emptyPct + naPct) * 10) / 10);

    return {
      field,
      columnType,
      total,
      nullCount,
      emptyCount,
      naCount,
      nullPct,
      emptyPct,
      naPct,
      gapPct,
      sampleMissingRows,
    };
  });

  stats.sort((a, b) => b.gapPct - a.gapPct);

  return { table, totalRows: rows.length, fields: stats };
}

type RawRow = Record<string, unknown> & { id: string };

/**
 * Fetch the raw JSON for a table (not formatted per-entity) and return it.
 * Separate from the per-entity fetchers so the field-gap scan reuses the
 * same API without re-computing per-entity profiles.
 */
async function fetchTableRows(table: string): Promise<RawRow[]> {
  switch (table) {
    case 'divisions':
      return fetchAllPaginated<RawRow>('/api/divisions/all', 'divisions');
    case 'division_personnel':
      return fetchAllPaginated<RawRow>('/api/division-personnel/all', 'divisionPersonnel');
    case 'funding_programs':
      return fetchAllPaginated<RawRow>('/api/funding-programs/all', 'fundingPrograms');
    case 'benchmark_results':
      return fetchAllPaginated<RawRow>('/api/benchmark-results/all', 'benchmarkResults');
    default:
      return [];
  }
}

/** List of tables covered by the field-gap scan. */
export const FIELD_GAP_TABLES = Object.keys(FIELD_GAP_CONFIGS);

export async function runFieldGapScan(tables?: string[]): Promise<FieldGapReport[]> {
  const selected = tables && tables.length > 0
    ? tables.filter(t => FIELD_GAP_CONFIGS[t])
    : FIELD_GAP_TABLES;

  const reports = await Promise.all(selected.map(async (table) => {
    const rows = await fetchTableRows(table);
    return profileFields(table, rows, FIELD_GAP_CONFIGS[table]);
  }));

  return reports;
}

export async function runTableScan(table: string): Promise<TableScanResult | null> {
  switch (table) {
    case 'grants': return scanGrantCompleteness();
    case 'personnel': return scanPersonnelCompleteness();
    case 'funding_rounds': case 'funding-rounds': return scanFundingRoundsCompleteness();
    case 'investments': return scanInvestmentsCompleteness();
    case 'benchmark_results': case 'benchmark-results': return scanBenchmarkResultsCompleteness();
    case 'divisions': return scanDivisionsLead();
    case 'division_personnel': case 'division-personnel': return scanDivisionPersonnelDates();
    case 'funding_programs': case 'funding-programs': return scanFundingProgramFields();
    case 'benchmark_result_sources': case 'benchmark-result-sources': return scanBenchmarkResultSources();
    case 'source_quality': case 'source-quality': return scanSourceQuality();
    default: return null;
  }
}
