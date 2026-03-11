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
import type { RecordEntry } from '../../packages/kb/src/types.ts';
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

/**
 * Resolve an entity reference to a canonical entity ID.
 * If the entity exists in the graph, returns its stable 10-char ID.
 * If not found (e.g. a display name like "D. E. Shaw Research"), returns as-is.
 */
function resolveEntityId(graph: Graph, entityId: string): string {
  const entity = graph.getEntity(entityId);
  return entity?.id ?? entityId;
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

// ── Extract all records ────────────────────────────────────────────────

function extractRecords(graph: Graph): {
  personnel: PersonnelRow[];
  grants: GrantRow[];
} {
  const personnelRows: PersonnelRow[] = [];
  const grantRows: GrantRow[] = [];

  for (const entity of graph.getAllEntities()) {
    const ownerEntityId = entity.id;
    const collections = graph.getRecordCollectionNames(entity.id);

    for (const collection of collections) {
      if (!PERSONNEL_COLLECTIONS.has(collection) && !GRANT_COLLECTIONS.has(collection)) {
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

  // Sync in batches (API limit: 500 items per request)
  const BATCH_SIZE = 500;

  if (personnel.length > 0) {
    let totalUpserted = 0;
    for (let i = 0; i < personnel.length; i += BATCH_SIZE) {
      const batch = personnel.slice(i, i + BATCH_SIZE);
      const result = await apiRequest<{ upserted: number }>('POST', '/api/personnel/sync', {
        items: batch,
      });
      if (result.ok) {
        totalUpserted += result.data.upserted;
      } else {
        console.error(`✗ Personnel sync failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${result.message}`);
        return { exitCode: 1, output: `Personnel sync failed: ${result.message}` };
      }
    }
    console.log(`✓ Synced ${totalUpserted} personnel records`);
  }

  if (grants.length > 0) {
    let totalUpserted = 0;
    for (let i = 0; i < grants.length; i += BATCH_SIZE) {
      const batch = grants.slice(i, i + BATCH_SIZE);
      const result = await apiRequest<{ upserted: number }>('POST', '/api/grants/sync', {
        items: batch,
      });
      if (result.ok) {
        totalUpserted += result.data.upserted;
      } else {
        console.error(`✗ Grants sync failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${result.message}`);
        return { exitCode: 1, output: `Grants sync failed: ${result.message}` };
      }
    }
    console.log(`✓ Synced ${totalUpserted} grant records`);
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
