/**
 * Data Source Manifest Registry — maps GrantSource IDs to their manifests.
 *
 * Part of Phase 2: Data Source Resources (Discussion #3567).
 */

import type { DataSourceManifest } from './types.ts';
import { FUNDER_IDS } from '../constants.ts';

// ---------------------------------------------------------------------------
// Manifests for each grant source
// ---------------------------------------------------------------------------

const coefficientGiving: DataSourceManifest = {
  sourceId: 'coefficient-giving',
  name: 'Coefficient Giving Grants Archive',
  fetchUrl: 'https://coefficientgiving.org/wp-content/uploads/Coefficient-Giving-Grants-Archive.csv',
  format: 'csv',
  accessMethod: 'direct_download',
  publisherEntityId: FUNDER_IDS.OPEN_PHILANTHROPY,
  updateFrequency: 'quarterly',
  cachePath: '/tmp/coefficient-giving-grants.csv',
  schema: {
    fields: [
      { sourceName: 'Grant', internalField: 'name', type: 'string' },
      { sourceName: 'Organization Name', internalField: 'grantee', type: 'string' },
      { sourceName: 'Focus Area', internalField: 'focusArea', type: 'string' },
      { sourceName: 'Amount', internalField: 'amount', type: 'currency', transform: 'strip_currency' },
      { sourceName: 'Date', internalField: 'date', type: 'date', transform: 'parse_date' },
      { sourceName: 'Details', internalField: 'description', type: 'string' },
    ],
    missingValues: ['', 'N/A'],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const eaFunds: DataSourceManifest = {
  sourceId: 'ea-funds',
  name: 'EA Funds Grants Database',
  fetchUrl: 'https://funds.effectivealtruism.org/api/grants',
  format: 'csv',
  accessMethod: 'api_endpoint',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/ea-funds-grants.csv',
  schema: {
    fields: [
      { sourceName: 'description', internalField: 'name', type: 'string' },
      { sourceName: 'fund', internalField: 'fund', type: 'string' },
      { sourceName: 'grantee', internalField: 'grantee', type: 'string' },
      { sourceName: 'amount', internalField: 'amount', type: 'number' },
      { sourceName: 'round', internalField: 'round', type: 'string' },
      { sourceName: 'year', internalField: 'date', type: 'date' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const sff: DataSourceManifest = {
  sourceId: 'sff',
  name: 'Survival and Flourishing Fund Recommendations',
  fetchUrl: 'https://survivalandflourishing.fund/recommendations',
  format: 'html_table',
  accessMethod: 'web_scrape',
  publisherEntityId: 'sid_pvJ50HupEQ',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/sff-recommendations.html',
  schema: {
    fields: [
      { sourceName: 'Round', internalField: 'round', type: 'string' },
      { sourceName: 'Source', internalField: 'funder', type: 'string' },
      { sourceName: 'Organization', internalField: 'grantee', type: 'string' },
      { sourceName: 'Amount', internalField: 'amount', type: 'currency', transform: 'strip_currency' },
      { sourceName: 'Receiving Charity', internalField: 'receivingCharity', type: 'string' },
      { sourceName: 'Purpose', internalField: 'purpose', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const manifund: DataSourceManifest = {
  sourceId: 'manifund',
  name: 'Manifund Projects',
  fetchUrl: 'https://manifund.org/api/v0/projects',
  format: 'json_api',
  accessMethod: 'api_endpoint',
  publisherEntityId: 'sid_fFVOuFZCRf',
  updateFrequency: 'weekly',
  cachePath: '/tmp/manifund-projects.json',
  schema: {
    fields: [
      { sourceName: 'title', internalField: 'name', type: 'string' },
      { sourceName: 'slug', internalField: 'slug', type: 'string' },
      { sourceName: 'created_at', internalField: 'date', type: 'date' },
      { sourceName: 'funding_goal', internalField: 'amount', type: 'number' },
      { sourceName: 'blurb', internalField: 'description', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['name', 'amount'],
    fuzzyFields: ['name'],
  },
};

const gatesFoundation: DataSourceManifest = {
  sourceId: 'gates-foundation',
  name: 'Gates Foundation Grants',
  fetchUrl: 'https://www.gatesfoundation.org/about/committed-grants',
  format: 'csv',
  accessMethod: 'direct_download',
  publisherEntityId: 'sid_l4EHdNDZqg',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/gates-foundation-grants.csv',
  schema: {
    fields: [
      { sourceName: 'GRANTEE', internalField: 'grantee', type: 'string' },
      { sourceName: 'PURPOSE', internalField: 'name', type: 'string' },
      { sourceName: 'TOPIC', internalField: 'focusArea', type: 'string' },
      { sourceName: 'DATE COMMITTED', internalField: 'date', type: 'date' },
      { sourceName: 'AMOUNT COMMITTED', internalField: 'amount', type: 'currency', transform: 'strip_currency' },
      { sourceName: 'DURATION (MONTHS)', internalField: 'duration', type: 'number' },
    ],
    missingValues: [''],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const givewell: DataSourceManifest = {
  sourceId: 'givewell',
  name: 'GiveWell Grants Database',
  fetchUrl: 'https://docs.google.com/spreadsheets/d/1z065ab9PPMu9i5KiQ4yLyQJPFQCfEzHSgtHulPiZeBo/export?format=csv&gid=0',
  format: 'csv',
  accessMethod: 'direct_download',
  publisherEntityId: 'sid_OwXl35e7bg',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/givewell-grants.csv',
  schema: {
    fields: [
      { sourceName: 'Top charity', internalField: 'grantee', type: 'string' },
      { sourceName: 'Total grant size', internalField: 'amount', type: 'currency', transform: 'strip_currency' },
      { sourceName: 'Date of grant approval', internalField: 'date', type: 'date' },
      { sourceName: 'Grant name', internalField: 'name', type: 'string' },
      { sourceName: 'Intervention', internalField: 'focusArea', type: 'string' },
      { sourceName: 'Funding source', internalField: 'fund', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const fli: DataSourceManifest = {
  sourceId: 'fli',
  name: 'Future of Life Institute Grants',
  fetchUrl: 'https://futureoflife.org/project/all-grants-awarded/',
  format: 'csv',
  accessMethod: 'web_scrape',
  publisherEntityId: 'sid_d9sWZtyVwg',
  updateFrequency: 'annual',
  cachePath: '/tmp/fli-grants.sql',
  schema: {
    fields: [
      { sourceName: 'title', internalField: 'name', type: 'string' },
      { sourceName: 'recipient', internalField: 'grantee', type: 'string' },
      { sourceName: 'amount', internalField: 'amount', type: 'number' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

// Sources with hardcoded data or non-standard formats — manifests for completeness
const acxGrants: DataSourceManifest = {
  sourceId: 'acx-grants',
  name: 'Astral Codex Ten Grants',
  fetchUrl: null,
  format: 'json_api',
  accessMethod: 'manual_export',
  publisherEntityId: 'sid_LBr3ocKKyQ',
  updateFrequency: 'annual',
  cachePath: '/tmp/acx-grants.json',
  schema: {
    fields: [
      { sourceName: 'recipient', internalField: 'grantee', type: 'string' },
      { sourceName: 'amount', internalField: 'amount', type: 'number' },
      { sourceName: 'round', internalField: 'round', type: 'string' },
      { sourceName: 'description', internalField: 'name', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const ftxFutureFund: DataSourceManifest = {
  sourceId: 'ftx-future-fund',
  name: 'FTX Future Fund Grants (Historical)',
  fetchUrl: null,
  format: 'csv',
  accessMethod: 'manual_export',
  updateFrequency: 'static',
  cachePath: '/tmp/ftx-future-fund-combined.sql',
  schema: {
    fields: [
      { sourceName: 'donee', internalField: 'grantee', type: 'string' },
      { sourceName: 'amount', internalField: 'amount', type: 'number' },
      { sourceName: 'date', internalField: 'date', type: 'date' },
      { sourceName: 'causeArea', internalField: 'focusArea', type: 'string' },
      { sourceName: 'intendedUse', internalField: 'description', type: 'string' },
      { sourceName: 'earmark', internalField: 'name', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const aria: DataSourceManifest = {
  sourceId: 'aria',
  name: 'ARIA Safeguarded AI Programme',
  fetchUrl: 'https://www.aria.org.uk/programmes/safeguarded-ai/',
  format: 'json_api',
  accessMethod: 'web_scrape',
  publisherEntityId: 'sid_XqjV4mbMXQ',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/aria-grants.json',
  schema: {
    fields: [
      { sourceName: 'grantee', internalField: 'grantee', type: 'string' },
      { sourceName: 'amount', internalField: 'amount', type: 'currency' },
      { sourceName: 'ta', internalField: 'focusArea', type: 'string' },
      { sourceName: 'title', internalField: 'name', type: 'string' },
      { sourceName: 'leads', internalField: 'description', type: 'string' },
      { sourceName: 'institutions', internalField: 'description', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'name'],
    fuzzyFields: ['grantee', 'name'],
  },
};

const wellcomeTrust: DataSourceManifest = {
  sourceId: 'wellcome-trust',
  name: 'Wellcome Trust Grants',
  fetchUrl: null,
  format: 'spreadsheet',
  accessMethod: 'manual_export',
  publisherEntityId: 'sid_D3QcAF9wzQ',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/wellcome-grants.csv',
  schema: {
    fields: [
      { sourceName: 'Recipient Org:Name', internalField: 'grantee', type: 'string' },
      { sourceName: 'Title', internalField: 'name', type: 'string' },
      { sourceName: 'Description', internalField: 'description', type: 'string' },
      { sourceName: 'Amount Awarded', internalField: 'amount', type: 'currency' },
      { sourceName: 'Currency', internalField: 'currency', type: 'string' },
      { sourceName: 'Award Date', internalField: 'date', type: 'date' },
      { sourceName: 'Grant Programme:Title', internalField: 'focusArea', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const fordFoundation: DataSourceManifest = {
  sourceId: 'ford-foundation',
  name: 'Ford Foundation Grants',
  fetchUrl: 'https://www.fordfoundation.org/work/our-grants/grants-database/grants-all',
  format: 'json_api',
  accessMethod: 'api_endpoint',
  publisherEntityId: 'sid_3ViojCH3Sw',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/ford-foundation-grants.json',
  schema: {
    fields: [
      { sourceName: 'grantee_name', internalField: 'grantee', type: 'string' },
      { sourceName: 'grant_amount', internalField: 'amount', type: 'number' },
      { sourceName: 'approval_date', internalField: 'date', type: 'date' },
      { sourceName: 'description', internalField: 'name', type: 'string' },
      { sourceName: 'programs', internalField: 'focusArea', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const vipulnaik: DataSourceManifest = {
  sourceId: 'vipulnaik',
  name: 'Vipul Naik Donations Database',
  fetchUrl: 'https://github.com/vipulnaik/donations',
  format: 'csv',
  accessMethod: 'direct_download',
  updateFrequency: 'monthly',
  cachePath: '/tmp/vipulnaik-combined.sql',
  schema: {
    fields: [
      { sourceName: 'donee', internalField: 'grantee', type: 'string' },
      { sourceName: 'amount', internalField: 'amount', type: 'number' },
      { sourceName: 'donation_date', internalField: 'date', type: 'date' },
      { sourceName: 'cause_area', internalField: 'focusArea', type: 'string' },
      { sourceName: 'donation_earmark', internalField: 'name', type: 'string' },
      { sourceName: 'notes', internalField: 'description', type: 'string' },
      { sourceName: 'url', internalField: 'sourceUrl', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const foresightPrizes: DataSourceManifest = {
  sourceId: 'foresight-prizes',
  name: 'Foresight Institute Prizes',
  fetchUrl: 'https://foresight.org/prizes/feynman-prizes/',
  format: 'json_api',
  accessMethod: 'web_scrape',
  publisherEntityId: 'sid_NPPTvNqRXA',
  updateFrequency: 'annual',
  cachePath: '/tmp/foresight-prizes.json',
  schema: {
    fields: [
      { sourceName: 'recipient', internalField: 'grantee', type: 'string' },
      { sourceName: 'year', internalField: 'date', type: 'number' },
      { sourceName: 'achievement', internalField: 'description', type: 'string' },
      { sourceName: 'institution', internalField: 'description', type: 'string' },
      { sourceName: 'category', internalField: 'focusArea', type: 'string' },
    ],
  },
  sourceCheck: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['date'],
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MANIFESTS: Record<string, DataSourceManifest> = {
  'coefficient-giving': coefficientGiving,
  'ea-funds': eaFunds,
  'sff': sff,
  'manifund': manifund,
  'gates-foundation': gatesFoundation,
  'givewell': givewell,
  'fli': fli,
  'acx-grants': acxGrants,
  'ftx-future-fund': ftxFutureFund,
  'aria': aria,
  'wellcome-trust': wellcomeTrust,
  'ford-foundation': fordFoundation,
  'vipulnaik': vipulnaik,
  'foresight-prizes': foresightPrizes,
};

export function getManifest(sourceId: string): DataSourceManifest | undefined {
  return MANIFESTS[sourceId];
}
