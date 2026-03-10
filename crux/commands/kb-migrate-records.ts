/**
 * KB Records Migration — YAML → PG
 *
 * Reads key-persons, board-seats, career-history, and grants records
 * from YAML files and syncs them to the wiki-server PG tables.
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
import { apiRequest } from '../lib/wiki-server/client.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

interface MigrateOptions extends BaseOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
}

// ── Personnel record types that map to the personnel PG table ─────────

const PERSONNEL_COLLECTIONS = new Set(['key-persons', 'board-seats', 'career-history']);
const GRANT_COLLECTIONS = new Set(['grants']);

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
  name: string;
  amount: number | null;
  currency: string;
  period: string | null;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

function resolveEntitySlug(graph: Graph, entityId: string): string {
  const entity = graph.getEntity(entityId);
  return entity?.slug ?? entityId;
}

function mapKeyPerson(
  record: RecordEntry,
  graph: Graph,
  ownerSlug: string,
): PersonnelRow {
  const f = record.fields;
  const personId = f.person
    ? resolveEntitySlug(graph, String(f.person))
    : record.displayName ?? record.key;

  return {
    id: personnelId(record.ownerEntityId, 'key-persons', record.key),
    personId,
    organizationId: ownerSlug,
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
  ownerSlug: string,
): PersonnelRow {
  const f = record.fields;
  const personId = f.member
    ? resolveEntitySlug(graph, String(f.member))
    : record.displayName ?? record.key;

  return {
    id: personnelId(record.ownerEntityId, 'board-seats', record.key),
    personId,
    organizationId: ownerSlug,
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
  graph: Graph,
  ownerSlug: string,
): PersonnelRow {
  const f = record.fields;
  // Career history: the owner IS the person, organization is a text field
  const orgText = f.organization != null ? String(f.organization) : 'Unknown';

  return {
    id: personnelId(record.ownerEntityId, 'career-history', record.key),
    personId: ownerSlug,
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
  _graph: Graph,
  ownerSlug: string,
): GrantRow {
  const f = record.fields;

  return {
    id: grantId(record.ownerEntityId, record.key),
    organizationId: ownerSlug,
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

// ── Extract all records ────────────────────────────────────────────────

function extractRecords(graph: Graph): {
  personnel: PersonnelRow[];
  grants: GrantRow[];
} {
  const personnelRows: PersonnelRow[] = [];
  const grantRows: GrantRow[] = [];

  for (const entity of graph.getAllEntities()) {
    const ownerSlug = entity.slug;
    const collections = graph.getRecordCollectionNames(entity.id);

    for (const collection of collections) {
      if (!PERSONNEL_COLLECTIONS.has(collection) && !GRANT_COLLECTIONS.has(collection)) {
        continue;
      }

      const records = graph.getRecords(entity.id, collection);
      for (const record of records) {
        if (collection === 'key-persons') {
          personnelRows.push(mapKeyPerson(record, graph, ownerSlug));
        } else if (collection === 'board-seats') {
          personnelRows.push(mapBoardSeat(record, graph, ownerSlug));
        } else if (collection === 'career-history') {
          personnelRows.push(mapCareerHistory(record, graph, ownerSlug));
        } else if (collection === 'grants') {
          grantRows.push(mapGrant(record, graph, ownerSlug));
        }
      }
    }
  }

  return { personnel: personnelRows, grants: grantRows };
}

// ── Stats subcommand ───────────────────────────────────────────────────

async function statsCommand(): Promise<CommandResult> {
  const { graph } = await loadKB(KB_DATA_DIR);
  const { personnel, grants } = extractRecords(graph);

  const byType: Record<string, number> = {};
  for (const row of personnel) {
    byType[row.roleType] = (byType[row.roleType] ?? 0) + 1;
  }

  const lines = [
    `Personnel records: ${personnel.length}`,
    ...Object.entries(byType).map(([type, count]) => `  ${type}: ${count}`),
    `Grant records: ${grants.length}`,
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

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Sync subcommand ────────────────────────────────────────────────────

async function syncCommand(options: MigrateOptions): Promise<CommandResult> {
  const dryRun = options.dryRun || options['dry-run'];
  const { graph } = await loadKB(KB_DATA_DIR);
  const { personnel, grants } = extractRecords(graph);

  console.log(`Found ${personnel.length} personnel records and ${grants.length} grant records`);

  if (dryRun) {
    console.log('\n--- DRY RUN: Personnel ---');
    for (const row of personnel.slice(0, 10)) {
      console.log(`  [${row.roleType}] ${row.personId} @ ${row.organizationId}: ${row.role} (${row.id})`);
    }
    if (personnel.length > 10) console.log(`  ... and ${personnel.length - 10} more`);

    console.log('\n--- DRY RUN: Grants ---');
    for (const row of grants) {
      console.log(`  ${row.organizationId}: ${row.name} ($${row.amount ?? '?'}) (${row.id})`);
    }

    return { exitCode: 0, output: `Dry run complete. ${personnel.length} personnel, ${grants.length} grants would be synced.` };
  }

  // Sync personnel
  if (personnel.length > 0) {
    const result = await apiRequest<{ upserted: number }>('POST', '/api/personnel/sync', {
      items: personnel,
    });
    if (result.ok) {
      console.log(`✓ Synced ${result.data.upserted} personnel records`);
    } else {
      console.error(`✗ Personnel sync failed: ${result.message}`);
      return { exitCode: 1, output: `Personnel sync failed: ${result.message}` };
    }
  }

  // Sync grants
  if (grants.length > 0) {
    const result = await apiRequest<{ upserted: number }>('POST', '/api/grants/sync', {
      items: grants,
    });
    if (result.ok) {
      console.log(`✓ Synced ${result.data.upserted} grant records`);
    } else {
      console.error(`✗ Grants sync failed: ${result.message}`);
      return { exitCode: 1, output: `Grants sync failed: ${result.message}` };
    }
  }

  return {
    exitCode: 0,
    output: `Synced ${personnel.length} personnel and ${grants.length} grants to wiki-server.`,
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
