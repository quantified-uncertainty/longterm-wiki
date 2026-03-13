/**
 * People Import-Key-Persons Subcommand
 *
 * Extract key-persons from KB YAML and sync to wiki-server PG.
 */

import type { CommandResult } from '../../lib/command-types.ts';
import {
  extractKeyPersons,
  toSyncItems,
  syncKeyPersons,
} from '../../lib/key-persons-import.ts';
import type { BaseOptions } from './shared.ts';

export async function importKeyPersonsCommand(
  _args: string[],
  options: BaseOptions,
): Promise<CommandResult> {
  const verbose = !!options.verbose;
  const sync = !!options.sync;
  const dryRun = !!options['dry-run'];

  const lines: string[] = [];
  lines.push('\n  Key Persons Import');
  lines.push(`  ${'='.repeat(40)}`);

  // Extract from YAML
  lines.push('  Extracting key-persons from KB YAML files...');
  const { records, unresolved } = await extractKeyPersons();

  lines.push(`  Found ${records.length} key-person entries across ${new Set(records.map(r => r.orgSlug)).size} organizations`);

  if (unresolved.length > 0) {
    lines.push(`\n  WARNING: ${unresolved.length} unresolved person slug(s):`);
    for (const u of unresolved) {
      lines.push(`    - ${u.orgSlug}/${u.yamlKey}: person="${u.personSlug}" not found`);
    }
  }

  // Group by org for display
  const byOrg = new Map<string, typeof records>();
  for (const rec of records) {
    const existing = byOrg.get(rec.orgSlug) ?? [];
    existing.push(rec);
    byOrg.set(rec.orgSlug, existing);
  }

  if (verbose) {
    lines.push('\n  By organization:');
    for (const [orgSlug, orgRecords] of [...byOrg.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`    ${orgSlug}: ${orgRecords.length} key persons`);
      for (const rec of orgRecords) {
        const status = rec.personEntityId ? 'OK' : 'UNRESOLVED';
        const founderTag = rec.isFounder ? ' [founder]' : '';
        lines.push(`      - ${rec.personSlug}: ${rec.title}${founderTag} (${status})`);
      }
    }
  }

  // Convert to sync items
  const syncItems = toSyncItems(records);
  lines.push(`\n  Sync items: ${syncItems.length} (${records.length - syncItems.length} skipped due to unresolved persons)`);

  // Sync to PG if requested
  if (sync) {
    try {
      const result = await syncKeyPersons(syncItems, dryRun);
      if (dryRun) {
        lines.push(`\n  DRY RUN: would sync ${syncItems.length} records`);
      } else {
        lines.push(`\n  Sync complete: ${result.upserted} upserted, ${result.failed} batch(es) failed`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`\n  Sync failed: ${message}`);
      return { exitCode: 1, output: lines.join('\n') };
    }
  } else {
    lines.push('\n  (preview only -- use --sync to write to PG, or --sync --dry-run to preview sync)');
  }

  return { exitCode: 0, output: lines.join('\n') };
}
