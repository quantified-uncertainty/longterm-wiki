/**
 * Cleanup script: delete personnel records with fabricated/unresolvable personIds.
 *
 * Root cause: The LLM enrichment pipeline sometimes hallucinated 10-char stableIds
 * instead of calling resolve_entity. These IDs don't match any entity, leaving
 * personEntityId null and no display name resolvable.
 *
 * See discussion #3387 for the full analysis.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod pnpm crux run crux/scripts/cleanup-personnel.ts --dry-run   # preview
 *   WIKI_SERVER_ENV=prod pnpm crux run crux/scripts/cleanup-personnel.ts             # delete
 */

import 'dotenv/config';
import { apiRequest } from '../lib/wiki-server/client.ts';

interface BrokenRecord {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  personEntityId: string | null;
  personDisplayName: string | null;
  personResolvedName: string | null;
  issueType: string;
}

interface BrokenResponse {
  records: BrokenRecord[];
  total: number;
}

interface DeleteResponse {
  deleted: number;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\n=== Personnel Cleanup ${dryRun ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // Fetch all broken records
  const result = await apiRequest<BrokenResponse>('GET', '/api/personnel/broken');
  if (!result.ok) {
    console.error('Failed to fetch broken records:', result.message);
    process.exit(1);
  }

  const { records, total } = result.data;
  console.log(`Found ${total} broken personnel records\n`);

  if (records.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  // Group by issue type
  const byType = new Map<string, BrokenRecord[]>();
  for (const r of records) {
    const list = byType.get(r.issueType) || [];
    list.push(r);
    byType.set(r.issueType, list);
  }

  for (const [type, recs] of byType) {
    console.log(`  ${type}: ${recs.length} records`);
  }
  console.log();

  // Group by organization for visibility
  const byOrg = new Map<string, number>();
  for (const r of records) {
    byOrg.set(r.organizationId, (byOrg.get(r.organizationId) || 0) + 1);
  }
  const topOrgs = [...byOrg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  console.log('Top affected organizations:');
  for (const [org, count] of topOrgs) {
    console.log(`  ${org}: ${count} broken records`);
  }
  console.log();

  // Filter to only unresolved-stableId records (the hallucinated ones)
  const toDelete = records.filter(r => r.issueType === 'unresolved-stableId');
  console.log(`Records to delete (unresolved-stableId): ${toDelete.length}`);

  if (dryRun) {
    console.log('\n[DRY RUN] Would delete these records. Run without --dry-run to execute.');
    // Show sample
    for (const r of toDelete.slice(0, 10)) {
      console.log(`  ${r.id}: personId=${r.personId} org=${r.organizationId} role="${r.role}"`);
    }
    if (toDelete.length > 10) {
      console.log(`  ... and ${toDelete.length - 10} more`);
    }
    return;
  }

  // Delete in batches
  const BATCH_SIZE = 100;
  let totalDeleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = toDelete.slice(i, i + BATCH_SIZE);
    const ids = batch.map(r => r.id);

    const deleteResult = await apiRequest<DeleteResponse>('POST', '/api/personnel/delete', { ids });
    if (!deleteResult.ok) {
      console.error(`Failed to delete batch ${i / BATCH_SIZE + 1}:`, deleteResult.message);
      continue;
    }

    totalDeleted += deleteResult.data.deleted;
    console.log(`  Deleted batch ${Math.floor(i / BATCH_SIZE) + 1}: ${deleteResult.data.deleted} records`);
  }

  console.log(`\n✓ Total deleted: ${totalDeleted} of ${toDelete.length} targeted records`);

  // Verify
  const verifyResult = await apiRequest<BrokenResponse>('GET', '/api/personnel/broken');
  if (verifyResult.ok) {
    console.log(`  Remaining broken: ${verifyResult.data.total}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
