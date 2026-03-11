/**
 * KB Records Migration — YAML → PG
 *
 * Reads key-persons, board-seats, career-history, grants, funding-rounds,
 * investments, and equity-positions records from YAML files and syncs them
 * to the wiki-server PG tables.
 *
 * Usage:
 *   crux kb migrate-records [--dry-run]
 *   crux kb migrate-records stats       Show what would be migrated
 */

import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { loadKB } from '../../packages/kb/src/loader.ts';
import { contentHash } from '../../packages/kb/src/ids.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { RecordEntry } from '../../packages/kb/src/types.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

interface MigrateOptions extends BaseOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
}

// ── Collection sets ──────────────────────────────────────────────────

const PERSONNEL_COLLECTIONS = new Set(['key-persons', 'board-seats', 'career-history']);
const GRANT_COLLECTIONS = new Set(['grants']);
const FUNDING_ROUND_COLLECTIONS = new Set(['funding-rounds']);
const INVESTMENT_COLLECTIONS = new Set(['investments']);
const EQUITY_POSITION_COLLECTIONS = new Set(['equity-positions']);

const ALL_MANAGED_COLLECTIONS = new Set([
  ...PERSONNEL_COLLECTIONS,
  ...GRANT_COLLECTIONS,
  ...FUNDING_ROUND_COLLECTIONS,
  ...INVESTMENT_COLLECTIONS,
  ...EQUITY_POSITION_COLLECTIONS,
]);

// ── ID generation ────────────────────────────────────────────────────

/**
 * Deterministic 10-char ID for a personnel record.
 * Uses the owner entity + collection + record key as the content key.
 */
function personnelId(ownerEntityId: string, collection: string, key: string): string {
  return contentHash([ownerEntityId, collection, key]);
}

/**
 * Deterministic 10-char ID for a grant record.
 */
function grantId(ownerEntityId: string, key: string): string {
  return contentHash([ownerEntityId, 'grants', key]);
}

/**
 * Deterministic 10-char ID for a funding round record.
 */
function fundingRoundId(ownerEntityId: string, key: string): string {
  return contentHash([ownerEntityId, 'funding-rounds', key]);
}

/**
 * Deterministic 10-char ID for an investment record.
 */
function investmentId(ownerEntityId: string, key: string): string {
  return contentHash([ownerEntityId, 'investments', key]);
}

/**
 * Deterministic 10-char ID for an equity position record.
 */
function equityPositionId(ownerEntityId: string, key: string): string {
  return contentHash([ownerEntityId, 'equity-positions', key]);
}

// ── Record → PG row mapping ─────────────────────────────────────────

interface PersonnelRow {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  roleType: 'key-person' | 'board' | 'career';
  startDate: string | null;
  endDate: string | null;
  isFounder: boolean;
  appointedBy: string | null;
  background: string | null;
  source: string | null;
  notes: string | null;
}

interface GrantRow {
  id: string;
  organizationId: string;
  granteeId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  period: string | null;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

interface FundingRoundRow {
  id: string;
  companyId: string;
  name: string;
  date: string | null;
  raised: number | null;
  valuation: number | null;
  instrument: string | null;
  leadInvestor: string | null;
  source: string | null;
  notes: string | null;
}

interface InvestmentRow {
  id: string;
  companyId: string;
  investorId: string;
  roundName: string | null;
  date: string | null;
  amount: number | null;
  stakeAcquired: string | null;
  instrument: string | null;
  role: string | null;
  conditions: string | null;
  source: string | null;
  notes: string | null;
}

interface EquityPositionRow {
  id: string;
  companyId: string;
  holderId: string;
  stake: string | null;
  source: string | null;
  notes: string | null;
  asOf: string | null;
  validEnd: string | null;
}

/**
 * Resolve an entity reference to a canonical entity ID.
 * If the entity exists in the graph, returns its stable 10-char ID.
 * If not found (e.g. a display name like "D. E. Shaw Research"), returns as-is.
 */
function resolveEntityId(graph: Graph, entityId: string): string {
  const entity = graph.getEntity(entityId);
  return entity?.id ?? entityId;
}

/**
 * Serialize a value that may be a number, array, or string to a JSON string for TEXT columns.
 * Arrays like [0.07, 0.15] are stored as JSON strings; scalars as plain strings.
 */
function serializeStakeValue(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function mapKeyPerson(
  record: RecordEntry,
  graph: Graph,
  ownerEntityId: string,
): PersonnelRow {
  const f = record.fields;
  const personId = f.person
    ? resolveEntityId(graph, String(f.person))
    : record.displayName ?? record.key;

  return {
    id: personnelId(record.ownerEntityId, 'key-persons', record.key),
    personId,
    organizationId: ownerEntityId,
    role: String(f.title ?? 'Unknown'),
    roleType: 'key-person',
    startDate: f.start != null ? String(f.start) : null,
    endDate: f.end != null ? String(f.end) : null,
    isFounder: Boolean(f.is_founder),
    appointedBy: null,
    background: null,
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
  };
}

function mapBoardSeat(
  record: RecordEntry,
  graph: Graph,
  ownerEntityId: string,
): PersonnelRow {
  const f = record.fields;
  const personId = f.member
    ? resolveEntityId(graph, String(f.member))
    : record.displayName ?? record.key;

  return {
    id: personnelId(record.ownerEntityId, 'board-seats', record.key),
    personId,
    organizationId: ownerEntityId,
    role: String(f.role ?? 'Board Member'),
    roleType: 'board',
    startDate: f.appointed != null ? String(f.appointed) : null,
    endDate: f.departed != null ? String(f.departed) : null,
    isFounder: false,
    appointedBy: f.appointed_by != null ? String(f.appointed_by) : null,
    background: f.background != null ? String(f.background) : null,
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
  };
}

function mapCareerHistory(
  record: RecordEntry,
  _graph: Graph,
  ownerEntityId: string,
): PersonnelRow {
  const f = record.fields;
  // Career history: the owner IS the person, organization is a free-text field.
  // Unlike personId/organizationId in key-persons/board-seats (which reference known
  // entities), career-history organizations may be non-entity strings like
  // "D. E. Shaw Research" that have no entity ID. We store the raw text as-is.
  const orgText = f.organization != null ? String(f.organization) : 'Unknown';

  return {
    id: personnelId(record.ownerEntityId, 'career-history', record.key),
    personId: ownerEntityId,
    organizationId: orgText,
    role: String(f.title ?? 'Unknown'),
    roleType: 'career',
    startDate: f.start != null ? String(f.start) : null,
    endDate: f.end != null ? String(f.end) : null,
    isFounder: false,
    appointedBy: null,
    background: null,
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
  };
}

function mapGrant(
  record: RecordEntry,
  graph: Graph,
  ownerEntityId: string,
): GrantRow {
  const f = record.fields;

  return {
    id: grantId(record.ownerEntityId, record.key),
    organizationId: ownerEntityId,
    granteeId: f.grantee != null ? resolveEntityId(graph, String(f.grantee)) : null,
    name: String(f.name ?? record.key),
    amount: f.amount != null ? Number(f.amount) : null,
    currency: 'USD',
    period: f.period != null ? String(f.period) : null,
    date: f.date != null ? String(f.date) : null,
    status: f.status != null ? String(f.status) : null,
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
  };
}

function mapFundingRound(
  record: RecordEntry,
  graph: Graph,
  ownerEntityId: string,
): FundingRoundRow {
  const f = record.fields;

  return {
    id: fundingRoundId(record.ownerEntityId, record.key),
    companyId: ownerEntityId,
    name: String(f.name ?? record.key),
    date: f.date != null ? String(f.date) : null,
    raised: f.raised != null ? Number(f.raised) : null,
    valuation: f.valuation != null ? Number(f.valuation) : null,
    instrument: f.instrument != null ? String(f.instrument) : null,
    leadInvestor: f.lead_investor != null ? resolveEntityId(graph, String(f.lead_investor)) : null,
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
  };
}

/**
 * Parse a numeric value that may be a scalar or an array range [min, max].
 * For array ranges, returns the average. Returns null if not parseable.
 */
function parseNumericOrRange(value: unknown): number | null {
  if (value == null) return null;
  if (Array.isArray(value) && value.length === 2) {
    const avg = (Number(value[0]) + Number(value[1])) / 2;
    return isNaN(avg) ? null : avg;
  }
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function mapInvestment(
  record: RecordEntry,
  graph: Graph,
  ownerEntityId: string,
): InvestmentRow {
  const f = record.fields;
  const investorId = f.investor
    ? resolveEntityId(graph, String(f.investor))
    : record.displayName ?? record.key;

  return {
    id: investmentId(record.ownerEntityId, record.key),
    companyId: ownerEntityId,
    investorId,
    roundName: f.round_name != null ? String(f.round_name) : null,
    date: f.date != null ? String(f.date) : null,
    amount: parseNumericOrRange(f.amount),
    stakeAcquired: serializeStakeValue(f.stake_acquired),
    instrument: f.instrument != null ? String(f.instrument) : null,
    role: f.role != null ? String(f.role) : null,
    conditions: f.conditions != null ? String(f.conditions) : null,
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
  };
}

function mapEquityPosition(
  record: RecordEntry,
  graph: Graph,
  ownerEntityId: string,
): EquityPositionRow {
  const f = record.fields;
  const holderId = f.holder
    ? resolveEntityId(graph, String(f.holder))
    : record.displayName ?? record.key;

  return {
    id: equityPositionId(record.ownerEntityId, record.key),
    companyId: ownerEntityId,
    holderId,
    stake: serializeStakeValue(f.stake),
    source: f.source != null ? String(f.source) : null,
    notes: f.notes != null ? String(f.notes) : null,
    asOf: record.asOf ?? null,
    validEnd: record.validEnd ?? null,
  };
}

// ── Extract all records ────────────────────────────────────────────────

interface ExtractedRecords {
  personnel: PersonnelRow[];
  grants: GrantRow[];
  fundingRounds: FundingRoundRow[];
  investments: InvestmentRow[];
  equityPositions: EquityPositionRow[];
}

function extractRecords(graph: Graph): ExtractedRecords {
  const personnelRows: PersonnelRow[] = [];
  const grantRows: GrantRow[] = [];
  const fundingRoundRows: FundingRoundRow[] = [];
  const investmentRows: InvestmentRow[] = [];
  const equityPositionRows: EquityPositionRow[] = [];

  for (const entity of graph.getAllEntities()) {
    const ownerEntityId = entity.id;
    const collections = graph.getRecordCollectionNames(entity.id);

    for (const collection of collections) {
      if (!ALL_MANAGED_COLLECTIONS.has(collection)) {
        continue;
      }

      const records = graph.getRecords(entity.id, collection);
      for (const record of records) {
        if (collection === 'key-persons') {
          personnelRows.push(mapKeyPerson(record, graph, ownerEntityId));
        } else if (collection === 'board-seats') {
          personnelRows.push(mapBoardSeat(record, graph, ownerEntityId));
        } else if (collection === 'career-history') {
          personnelRows.push(mapCareerHistory(record, graph, ownerEntityId));
        } else if (collection === 'grants') {
          grantRows.push(mapGrant(record, graph, ownerEntityId));
        } else if (collection === 'funding-rounds') {
          fundingRoundRows.push(mapFundingRound(record, graph, ownerEntityId));
        } else if (collection === 'investments') {
          investmentRows.push(mapInvestment(record, graph, ownerEntityId));
        } else if (collection === 'equity-positions') {
          equityPositionRows.push(mapEquityPosition(record, graph, ownerEntityId));
        }
      }
    }
  }

  return {
    personnel: personnelRows,
    grants: grantRows,
    fundingRounds: fundingRoundRows,
    investments: investmentRows,
    equityPositions: equityPositionRows,
  };
}

// ── Stats subcommand ───────────────────────────────────────────────────

async function statsCommand(): Promise<CommandResult> {
  const { graph } = await loadKB(KB_DATA_DIR);
  const { personnel, grants, fundingRounds, investments, equityPositions } = extractRecords(graph);

  const byType: Record<string, number> = {};
  for (const row of personnel) {
    byType[row.roleType] = (byType[row.roleType] ?? 0) + 1;
  }

  const lines = [
    `Personnel records: ${personnel.length}`,
    ...Object.entries(byType).map(([type, count]) => `  ${type}: ${count}`),
    `Grant records: ${grants.length}`,
    `Funding round records: ${fundingRounds.length}`,
    `Investment records: ${investments.length}`,
    `Equity position records: ${equityPositions.length}`,
    '',
    'Personnel by organization:',
  ];

  const byOrg: Record<string, number> = {};
  for (const row of personnel) {
    if (row.roleType !== 'career') {
      byOrg[row.organizationId] = (byOrg[row.organizationId] ?? 0) + 1;
    }
  }
  for (const [org, count] of Object.entries(byOrg).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${org}: ${count}`);
  }

  lines.push('', 'Funding rounds by company:');
  const frByCompany: Record<string, number> = {};
  for (const row of fundingRounds) {
    frByCompany[row.companyId] = (frByCompany[row.companyId] ?? 0) + 1;
  }
  for (const [company, count] of Object.entries(frByCompany).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${company}: ${count}`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Batch sync helper ─────────────────────────────────────────────────

async function syncBatch<T>(
  label: string,
  rows: T[],
  endpoint: string,
  batchSize: number = 500,
): Promise<{ ok: boolean; synced: number; error?: string }> {
  if (rows.length === 0) return { ok: true, synced: 0 };

  let totalUpserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const result = await apiRequest<{ upserted: number }>('POST', endpoint, {
      items: batch,
    });
    if (result.ok) {
      totalUpserted += result.data.upserted;
    } else {
      const msg = `${label} sync failed (batch ${Math.floor(i / batchSize) + 1}): ${result.message}`;
      console.error(`✗ ${msg}`);
      return { ok: false, synced: totalUpserted, error: msg };
    }
  }
  console.log(`✓ Synced ${totalUpserted} ${label} records`);
  return { ok: true, synced: totalUpserted };
}

// ── Sync subcommand ────────────────────────────────────────────────────

async function syncCommand(options: MigrateOptions): Promise<CommandResult> {
  const dryRun = options.dryRun || options['dry-run'];
  const { graph } = await loadKB(KB_DATA_DIR);
  const { personnel, grants, fundingRounds, investments, equityPositions } = extractRecords(graph);

  const counts = {
    personnel: personnel.length,
    grants: grants.length,
    fundingRounds: fundingRounds.length,
    investments: investments.length,
    equityPositions: equityPositions.length,
  };
  console.log(`Found: ${counts.personnel} personnel, ${counts.grants} grants, ${counts.fundingRounds} funding rounds, ${counts.investments} investments, ${counts.equityPositions} equity positions`);

  if (dryRun) {
    console.log('\n--- DRY RUN: Personnel ---');
    for (const row of personnel.slice(0, 10)) {
      console.log(`  [${row.roleType}] ${row.personId} @ ${row.organizationId}: ${row.role} (${row.id})`);
    }
    if (personnel.length > 10) console.log(`  ... and ${personnel.length - 10} more`);

    console.log('\n--- DRY RUN: Grants ---');
    for (const row of grants.slice(0, 10)) {
      console.log(`  ${row.organizationId}: ${row.name} ($${row.amount ?? '?'}) (${row.id})`);
    }
    if (grants.length > 10) console.log(`  ... and ${grants.length - 10} more`);

    console.log('\n--- DRY RUN: Funding Rounds ---');
    for (const row of fundingRounds.slice(0, 10)) {
      console.log(`  ${row.companyId}: ${row.name} ($${row.raised ?? '?'}) (${row.id})`);
    }
    if (fundingRounds.length > 10) console.log(`  ... and ${fundingRounds.length - 10} more`);

    console.log('\n--- DRY RUN: Investments ---');
    for (const row of investments.slice(0, 10)) {
      console.log(`  ${row.investorId} → ${row.companyId}: ${row.roundName ?? 'unknown round'} ($${row.amount ?? '?'}) (${row.id})`);
    }
    if (investments.length > 10) console.log(`  ... and ${investments.length - 10} more`);

    console.log('\n--- DRY RUN: Equity Positions ---');
    for (const row of equityPositions.slice(0, 10)) {
      console.log(`  ${row.holderId} @ ${row.companyId}: stake=${row.stake ?? '?'} (${row.id})`);
    }
    if (equityPositions.length > 10) console.log(`  ... and ${equityPositions.length - 10} more`);

    return {
      exitCode: 0,
      output: `Dry run complete. ${counts.personnel} personnel, ${counts.grants} grants, ${counts.fundingRounds} funding rounds, ${counts.investments} investments, ${counts.equityPositions} equity positions would be synced.`,
    };
  }

  // Sync each record type
  const results = [
    await syncBatch('personnel', personnel, '/api/personnel/sync'),
    await syncBatch('grants', grants, '/api/grants/sync'),
    await syncBatch('funding-rounds', fundingRounds, '/api/funding-rounds/sync'),
    await syncBatch('investments', investments, '/api/investments/sync'),
    await syncBatch('equity-positions', equityPositions, '/api/equity-positions/sync'),
  ];

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    return {
      exitCode: 1,
      output: `Sync partially failed: ${failed.map(r => r.error).join('; ')}`,
    };
  }

  return {
    exitCode: 0,
    output: `Synced ${counts.personnel} personnel, ${counts.grants} grants, ${counts.fundingRounds} funding rounds, ${counts.investments} investments, ${counts.equityPositions} equity positions to wiki-server.`,
  };
}

// ── Command dispatch ───────────────────────────────────────────────────

export async function run(
  args: string[],
  options: MigrateOptions,
): Promise<CommandResult> {
  const subcommand = args[0] ?? 'sync';

  switch (subcommand) {
    case 'stats':
      return statsCommand();
    case 'sync':
      return syncCommand(options);
    default:
      return {
        exitCode: 1,
        output: `Unknown subcommand: ${subcommand}\n\nUsage:\n  crux kb migrate-records [sync]    Sync records to PG\n  crux kb migrate-records stats     Show what would be migrated\n  crux kb migrate-records sync --dry-run   Preview without syncing`,
      };
  }
}
