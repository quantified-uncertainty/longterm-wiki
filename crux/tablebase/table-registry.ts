/**
 * Centralized registry of table-to-API mappings.
 * Eliminates duplicated switch statements across tablebase commands and tools.
 *
 * Every tablebase entity type with a /sync endpoint should have an entry here.
 * The completeness validator (validate-tablebase-completeness.ts) cross-checks
 * this registry against actual route files.
 */

export interface TableConfig {
  /** API path for fetching existing records by entity, with entityId placeholder */
  fetchByEntityPath: (entityId: string) => string;
  /** Key in the API response containing the records array */
  resultKey: string;
  /** API path for sync/submit */
  syncPath: string;
  /** HTTP method for sync */
  syncMethod: 'POST' | 'PATCH';
  /** Body key wrapping the records array in sync request */
  syncBodyKey: string;
  /** API path for delete-batch (null if no delete endpoint) */
  deletePath: string | null;
  /**
   * The sourceTable string used in the things table for this entity type.
   * Null if this table doesn't sync to things.
   */
  thingsSourceTable: string | null;
  /**
   * When true, the sync endpoint requires every record to include inline
   * source-check. Set for tables that have reached Phase 5 hard enforcement
   * (Discussion #3875). The CLI appends ?requireSourceCheck=true to the sync path.
   */
  requireSourceCheck?: boolean;
}

const TABLE_CONFIGS: Record<string, TableConfig> = {
  // ── Financial data ──────────────────────────────────────────────────
  personnel: {
    fetchByEntityPath: (id) => `/api/personnel/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'personnel',
    syncPath: '/api/personnel/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/personnel/delete',
    thingsSourceTable: 'personnel',
    requireSourceCheck: true,
  },
  grants: {
    fetchByEntityPath: (id) => `/api/grants/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'grants',
    syncPath: '/api/grants/batch-update-grantee',
    syncMethod: 'PATCH',
    syncBodyKey: 'items',
    deletePath: '/api/grants/delete-batch',
    thingsSourceTable: 'grants',
    requireSourceCheck: true,
  },
  'funding-rounds': {
    fetchByEntityPath: (id) => `/api/funding-rounds/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'fundingRounds',
    syncPath: '/api/funding-rounds/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/funding-rounds/delete-batch',
    thingsSourceTable: 'funding_rounds',
  },
  investments: {
    fetchByEntityPath: (id) => `/api/investments/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'investments',
    syncPath: '/api/investments/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/investments/delete-batch',
    thingsSourceTable: 'investments',
  },
  'equity-positions': {
    fetchByEntityPath: (id) => `/api/equity-positions/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'equityPositions',
    syncPath: '/api/equity-positions/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/equity-positions/delete-batch',
    thingsSourceTable: 'equity_positions',
  },
  'funding-programs': {
    fetchByEntityPath: (id) => `/api/funding-programs/by-org/${encodeURIComponent(id)}`,
    resultKey: 'fundingPrograms',
    syncPath: '/api/funding-programs/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/funding-programs/delete-batch',
    thingsSourceTable: 'funding_programs',
  },

  // ── AI/benchmarks ───────────────────────────────────────────────────
  benchmarks: {
    fetchByEntityPath: () => '/api/benchmarks/all',
    resultKey: 'benchmarks',
    syncPath: '/api/benchmarks/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/benchmarks/delete-batch',
    thingsSourceTable: 'benchmarks',
  },
  'benchmark-results': {
    fetchByEntityPath: (id) => `/api/benchmark-results/by-model/${encodeURIComponent(id)}`,
    resultKey: 'benchmarkResults',
    syncPath: '/api/benchmark-results/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/benchmark-results/delete-batch',
    thingsSourceTable: 'benchmark_results',
  },
  'prediction-market-questions': {
    fetchByEntityPath: (id) => `/api/prediction-markets/questions/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'questions',
    syncPath: '/api/prediction-markets/questions/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/prediction-markets/questions/delete-batch',
    thingsSourceTable: null,
  },
  'secondary-market-prices': {
    fetchByEntityPath: (id) => `/api/secondary-market-prices/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'prices',
    syncPath: '/api/secondary-market-prices/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/secondary-market-prices/delete-batch',
    thingsSourceTable: null,
  },

  // ── Organizations ───────────────────────────────────────────────────
  divisions: {
    fetchByEntityPath: (id) => `/api/divisions/by-org/${encodeURIComponent(id)}`,
    resultKey: 'divisions',
    syncPath: '/api/divisions/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/divisions/delete-batch',
    thingsSourceTable: 'divisions',
  },
  'division-personnel': {
    fetchByEntityPath: (id) => `/api/division-personnel/by-division/${encodeURIComponent(id)}`,
    resultKey: 'divisionPersonnel',
    syncPath: '/api/division-personnel/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/division-personnel/delete-batch',
    thingsSourceTable: 'division_personnel',
  },
  publications: {
    fetchByEntityPath: (id) => `/api/publications/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'publications',
    syncPath: '/api/publications/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/publications/delete-batch',
    thingsSourceTable: 'publications',
  },

  // ── Cross-entity ────────────────────────────────────────────────────
  'entity-events': {
    fetchByEntityPath: (id) => `/api/entity-events/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'events',
    syncPath: '/api/entity-events/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/entity-events/delete-batch',
    thingsSourceTable: 'entity_events',
  },
  'entity-assessments': {
    fetchByEntityPath: (id) => `/api/entity-assessments/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'assessments',
    syncPath: '/api/entity-assessments/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/entity-assessments/delete-batch',
    thingsSourceTable: 'entity_assessments',
  },
  'entity-resources': {
    fetchByEntityPath: (id) => `/api/entity-resources?entityId=${encodeURIComponent(id)}`,
    resultKey: 'items',
    syncPath: '/api/entity-resources/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/entity-resources/delete-batch',
    thingsSourceTable: 'entity_resources',
  },
  'policy-stakeholders': {
    fetchByEntityPath: (id) => `/api/policy-stakeholders/by-policy/${encodeURIComponent(id)}`,
    resultKey: 'policyStakeholders',
    syncPath: '/api/policy-stakeholders/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/policy-stakeholders/delete-batch',
    thingsSourceTable: 'policy_stakeholders',
  },
  'research-areas': {
    fetchByEntityPath: () => '/api/research-areas/all',
    resultKey: 'researchAreas',
    syncPath: '/api/research-areas/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/research-areas/delete-batch',
    thingsSourceTable: 'research_areas',
  },

  // ── Political ───────────────────────────────────────────────────────
  'political-races': {
    fetchByEntityPath: () => '/api/political-races/all',
    resultKey: 'races',
    syncPath: '/api/political-races/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    // Uses HTTP DELETE (not POST) — hand-written endpoint that also cleans up race_candidates things.
    // The generic deleteBatch() client won't work for this route; use direct apiRequest instead.
    deletePath: null,
    thingsSourceTable: 'political_races',
  },
  'political-scores': {
    fetchByEntityPath: (id) => `/api/political-scores/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'scores',
    syncPath: '/api/political-scores/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/political-scores/delete-batch',
    thingsSourceTable: null,
  },
  'political-offices': {
    fetchByEntityPath: (id) => `/api/political-offices/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'offices',
    syncPath: '/api/political-offices/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/political-offices/delete-batch',
    thingsSourceTable: null,
  },
  'political-votes': {
    fetchByEntityPath: (id) => `/api/political-votes/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'votes',
    syncPath: '/api/political-votes/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/political-votes/delete-batch',
    thingsSourceTable: null,
  },
  'campaign-finance': {
    fetchByEntityPath: (id) => `/api/campaign-finance/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'records',
    syncPath: '/api/campaign-finance/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/campaign-finance/delete-batch',
    thingsSourceTable: null,
  },

  // ── External data ───────────────────────────────────────────────────
  'website-sources': {
    fetchByEntityPath: (id) => `/api/website-sources/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'sources',
    syncPath: '/api/website-sources/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/website-sources/delete-batch',
    thingsSourceTable: null,
  },
  'data-sources': {
    fetchByEntityPath: () => '/api/data-sources',
    resultKey: 'dataSources',
    syncPath: '/api/data-sources/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/data-sources/delete-batch',
    thingsSourceTable: null,
  },
  'platform-accounts': {
    fetchByEntityPath: (id) => `/api/platform-accounts/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'accounts',
    syncPath: '/api/platform-accounts/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/platform-accounts/delete-batch',
    thingsSourceTable: null,
  },
};

// Scanner uses underscored table names — map them to the canonical hyphenated form
const TABLE_ALIASES: Record<string, string> = {
  funding_rounds: 'funding-rounds',
  benchmark_results: 'benchmark-results',
  prediction_market_questions: 'prediction-market-questions',
  secondary_market_prices: 'secondary-market-prices',
  division_personnel: 'division-personnel',
  equity_positions: 'equity-positions',
  funding_programs: 'funding-programs',
  entity_events: 'entity-events',
  entity_assessments: 'entity-assessments',
  entity_resources: 'entity-resources',
  policy_stakeholders: 'policy-stakeholders',
  research_areas: 'research-areas',
  political_races: 'political-races',
  political_scores: 'political-scores',
  political_offices: 'political-offices',
  political_votes: 'political-votes',
  campaign_finance: 'campaign-finance',
  website_sources: 'website-sources',
  data_sources: 'data-sources',
  platform_accounts: 'platform-accounts',
};

export function getTableConfig(table: string): TableConfig | null {
  const canonical = TABLE_ALIASES[table] ?? table;
  return TABLE_CONFIGS[canonical] ?? null;
}

export const VALID_TABLES = Object.keys(TABLE_CONFIGS);

/** Get the canonical (hyphenated) table name from any form. */
export function canonicalTableName(table: string): string {
  return TABLE_ALIASES[table] ?? table;
}
