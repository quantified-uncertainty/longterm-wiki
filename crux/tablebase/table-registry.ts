/**
 * Centralized registry of table-to-API mappings.
 * Eliminates duplicated switch statements across tablebase commands and tools.
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
  /**
   * When true, the sync endpoint requires every record to include inline
   * source-check. Set for tables that have reached Phase 5 hard enforcement
   * (Discussion #3875). The CLI appends ?requireSourceCheck=true to the sync path.
   */
  requireSourceCheck?: boolean;
}

const TABLE_CONFIGS: Record<string, TableConfig> = {
  personnel: {
    fetchByEntityPath: (id) => `/api/personnel/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'personnel',
    syncPath: '/api/personnel/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    requireSourceCheck: true,
  },
  grants: {
    fetchByEntityPath: (id) => `/api/grants/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'grants',
    syncPath: '/api/grants/batch-update-grantee',
    syncMethod: 'PATCH',
    syncBodyKey: 'items',
    requireSourceCheck: true,
  },
  'funding-rounds': {
    fetchByEntityPath: (id) => `/api/funding-rounds/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'fundingRounds',
    syncPath: '/api/funding-rounds/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
  investments: {
    fetchByEntityPath: (id) => `/api/investments/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'investments',
    syncPath: '/api/investments/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
  'benchmark-results': {
    fetchByEntityPath: (id) => `/api/benchmark-results/by-model/${encodeURIComponent(id)}`,
    resultKey: 'benchmarkResults',
    syncPath: '/api/benchmark-results/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
  'prediction-market-questions': {
    fetchByEntityPath: (id) => `/api/prediction-markets/questions/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'questions',
    syncPath: '/api/prediction-markets/questions/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
  'secondary-market-prices': {
    fetchByEntityPath: (id) => `/api/secondary-market-prices/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'prices',
    syncPath: '/api/secondary-market-prices/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
  publications: {
    fetchByEntityPath: (id) => `/api/publications/by-entity/${encodeURIComponent(id)}`,
    resultKey: 'publications',
    syncPath: '/api/publications/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
  divisions: {
    fetchByEntityPath: (id) => `/api/divisions/by-org/${encodeURIComponent(id)}`,
    resultKey: 'divisions',
    syncPath: '/api/divisions/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
  },
};

// Scanner uses underscored table names — map them to the canonical hyphenated form
const TABLE_ALIASES: Record<string, string> = {
  funding_rounds: 'funding-rounds',
  benchmark_results: 'benchmark-results',
  prediction_market_questions: 'prediction-market-questions',
  secondary_market_prices: 'secondary-market-prices',
};

export function getTableConfig(table: string): TableConfig | null {
  const canonical = TABLE_ALIASES[table] ?? table;
  return TABLE_CONFIGS[canonical] ?? null;
}

export const VALID_TABLES = Object.keys(TABLE_CONFIGS);
