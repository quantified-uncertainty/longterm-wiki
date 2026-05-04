/**
 * Clean Contradicted Records — export + delete records with contradicted verdicts.
 *
 * Fetches all contradicted sourcing verdicts, exports the underlying
 * records to a JSON backup, and optionally deletes them.
 *
 * Usage:
 *   crux tb verify clean                    Preview contradicted records (dry run)
 *   crux tb verify clean --apply            Export to JSON + delete records
 *   crux tb verify clean --type=grant       Filter to a single record type
 */

import type { CommandResult } from '../lib/command-types.ts';
import { getFailures, type VerdictEntry } from '../lib/wiki-server/sourcing.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { deleteBatch } from '../lib/wiki-server/delete-batch.ts';
import { truncate } from '../lib/text-utils.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Record types that live in PG and can be deleted via delete-batch
const PG_RECORD_TYPES = new Set([
  'grant',
  'personnel',
  'funding-program',
  'funding-round',
  'division',
  'publication',
  'investment',
  'equity-position',
  'benchmark-result',
  'entity-event',
  'entity-assessment',
  'secondary-market-price',
]);

// Map record type → API endpoint for fetching all records (used to get full data for backup)
const FETCH_ALL_ENDPOINTS: Record<string, { path: string; key: string }> = {
  grant: { path: '/api/grants/all', key: 'grants' },
  personnel: { path: '/api/personnel/all', key: 'personnel' },
  'funding-program': { path: '/api/funding-programs/all', key: 'fundingPrograms' },
  'funding-round': { path: '/api/funding-rounds/all', key: 'fundingRounds' },
  division: { path: '/api/divisions/all', key: 'divisions' },
  publication: { path: '/api/publications/all', key: 'publications' },
  investment: { path: '/api/investments/all', key: 'investments' },
  'equity-position': { path: '/api/equity-positions/all', key: 'equityPositions' },
  'benchmark-result': { path: '/api/benchmark-results/all', key: 'benchmarkResults' },
  'entity-event': { path: '/api/entity-events/all', key: 'events' },
  'entity-assessment': { path: '/api/entity-assessments/all', key: 'assessments' },
  'secondary-market-price': { path: '/api/secondary-market-prices/all', key: 'prices' },
};

// Map record type → delete-batch table name
const DELETE_TABLE_MAP: Record<string, string> = {
  grant: 'grants',
  personnel: 'personnel',
  'funding-program': 'funding-programs',
  'funding-round': 'funding-rounds',
  division: 'divisions',
  publication: 'publications',
  investment: 'investments',
  'equity-position': 'equity-positions',
  'benchmark-result': 'benchmark-results',
  'entity-event': 'entity-events',
  'entity-assessment': 'entity-assessments',
  'secondary-market-price': 'secondary-market-prices',
};

interface CleanOptions {
  apply?: boolean;
  type?: string;
}

/** Fetch all records of a given type, paginating as needed. */
async function fetchAllRecords(
  recordType: string,
): Promise<Record<string, unknown>[]> {
  const config = FETCH_ALL_ENDPOINTS[recordType];
  if (!config) return [];

  const allRecords: Record<string, unknown>[] = [];
  let offset = 0;
  const pageSize = 500;

  while (true) {
    // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
    const result = await apiRequest<Record<string, unknown>>(
      'GET',
      `${config.path}?limit=${pageSize}&offset=${offset}`,
    );
    if (!result.ok) {
      console.warn(`Failed to fetch ${recordType} records: ${result.message}`);
      break;
    }
    const items = (result.data[config.key] as Record<string, unknown>[]) || [];
    allRecords.push(...items);
    if (items.length < pageSize) break;
    offset += pageSize;
  }

  return allRecords;
}

export async function cleanContradictedCommand(
  _args: string[],
  options: CleanOptions,
): Promise<CommandResult> {
  const apply = !!options.apply;
  const filterType = options.type;
  const lines: string[] = [];

  lines.push('\x1b[1m=== Clean Contradicted Records ===\x1b[0m');
  if (!apply) {
    lines.push('\x1b[33mDRY RUN — use --apply to export and delete\x1b[0m');
  }
  lines.push('');

  // Step 1: Fetch all contradicted verdicts (paginated via failures endpoint)
  lines.push('Fetching contradicted verdicts...');
  const allVerdicts: VerdictEntry[] = [];
  let fetchOffset = 0;
  const pageSize = 200; // Server caps at 200
  while (true) {
    const result = await getFailures({
      error_type: 'contradicted',
      limit: pageSize,
      offset: fetchOffset,
    });
    if (!result.ok) {
      return { exitCode: 1, output: `Failed to fetch verdicts: ${result.error}` };
    }
    const data = result.data as { items: VerdictEntry[]; total: number };
    allVerdicts.push(...data.items);
    if (allVerdicts.length >= data.total || data.items.length < pageSize) break;
    fetchOffset += pageSize;
  }
  // Deduplicate by recordType+recordId (verdicts may have multiple field entries)
  const seen = new Set<string>();
  const uniqueVerdicts = allVerdicts.filter((v) => {
    const key = `${v.recordType}:${v.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Step 2: Group by record type
  const byType = new Map<string, VerdictEntry[]>();
  for (const v of uniqueVerdicts) {
    if (filterType && v.recordType !== filterType) continue;
    const existing = byType.get(v.recordType) || [];
    existing.push(v);
    byType.set(v.recordType, existing);
  }

  lines.push(`Total contradicted verdicts: ${uniqueVerdicts.length} (${allVerdicts.length} including field-level)`);
  lines.push('');

  // Summary table
  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, verdicts] of byType) {
    const deletable = PG_RECORD_TYPES.has(type) ? '✓ deletable' : '⚠ manual review';
    lines.push(`  ${type.padEnd(22)} ${String(verdicts.length).padStart(4)}  ${deletable}`);
  }
  lines.push('');

  // Step 3: For PG record types, fetch full records and prepare backup
  const backup: Record<string, { verdicts: VerdictEntry[]; records: Record<string, unknown>[] }> = {};
  const deleteQueue: { table: string; ids: string[] }[] = [];

  for (const [recordType, verdicts] of byType) {
    if (!PG_RECORD_TYPES.has(recordType)) {
      lines.push(`\x1b[33m⚠ Skipping ${recordType} (${verdicts.length} records) — not a PG table, needs manual review\x1b[0m`);
      continue;
    }

    const contradictedIds = new Set(verdicts.map((v) => v.recordId));

    // Fetch all records of this type and filter to contradicted ones
    lines.push(`Fetching ${recordType} records for backup...`);
    const allRecords = await fetchAllRecords(recordType);
    const matchedRecords = allRecords.filter((r) =>
      contradictedIds.has(r.id as string),
    );

    lines.push(
      `  Found ${matchedRecords.length}/${contradictedIds.size} records in DB ` +
        `(${contradictedIds.size - matchedRecords.length} already deleted or missing)`,
    );

    backup[recordType] = {
      verdicts,
      records: matchedRecords,
    };

    if (matchedRecords.length > 0) {
      const table = DELETE_TABLE_MAP[recordType];
      if (table) {
        deleteQueue.push({
          table,
          ids: matchedRecords.map((r) => r.id as string),
        });
      }
    }

    // List the records
    for (const v of verdicts) {
      const record = matchedRecords.find((r) => r.id === v.recordId);
      const name = v.displayName || (record?.name as string) || v.recordId;
      const status = record ? '\x1b[31m✗\x1b[0m' : '\x1b[2m⊘\x1b[0m';
      lines.push(`  ${status} ${name}`);
      if (v.reasoning) {
        lines.push(`    \x1b[2m${truncate(v.reasoning, 153, { ellipsis: '...' })}\x1b[0m`);
      }
    }
    lines.push('');
  }

  // Step 4: If --apply, write backup and delete
  if (apply && deleteQueue.length > 0) {
    // Write backup
    const backupDir = path.resolve(process.cwd(), '.claude', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `contradicted-records-${timestamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    lines.push(`\x1b[32m✓ Backup written to ${backupPath}\x1b[0m`);
    lines.push('');

    // Delete records
    let totalDeleted = 0;
    for (const { table, ids } of deleteQueue) {
      lines.push(`Deleting ${ids.length} ${table} records...`);
      const result = await deleteBatch(table, ids);
      if (result.ok) {
        lines.push(`  \x1b[32m✓ Deleted ${result.data.deleted} records\x1b[0m`);
        totalDeleted += result.data.deleted;
      } else {
        lines.push(`  \x1b[31m✗ Failed: ${result.message}\x1b[0m`);
      }
    }

    lines.push('');
    lines.push(`\x1b[1mTotal deleted: ${totalDeleted} records\x1b[0m`);
    lines.push('');
    lines.push('Note: Source-check verdicts are preserved (display_name survives deletion).');
    lines.push('Facts and citations with contradicted verdicts need manual review.');
  } else if (apply) {
    lines.push('\x1b[32mNo PG records to delete.\x1b[0m');
  }

  // Summary of non-PG types
  const nonPgTypes = [...byType.entries()].filter(([type]) => !PG_RECORD_TYPES.has(type));
  if (nonPgTypes.length > 0) {
    lines.push('\x1b[1mManual review needed:\x1b[0m');
    for (const [type, verdicts] of nonPgTypes) {
      lines.push(`  ${type}: ${verdicts.length} contradicted verdicts`);
      if (type === 'fact') {
        lines.push('    → FactBase YAML files need manual correction in packages/factbase/data/fb-entities/');
      } else if (type === 'citation') {
        lines.push('    → Citation content may need re-ingestion or URL update');
      }
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}
