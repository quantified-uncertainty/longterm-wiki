/**
 * Clean up garbage personnel records from the PG personnel table.
 *
 * Identifies and deletes:
 * 1. Records with unresolved stableId as personId (no entity match, no displayable name)
 * 2. Records with "new:" prefix that were never resolved
 * 3. Duplicate records (same person at same org)
 *
 * Usage:
 *   pnpm tsx crux/scripts/cleanup-personnel.ts --dry-run   # preview what would be deleted
 *   pnpm tsx crux/scripts/cleanup-personnel.ts              # actually delete
 */

import { apiRequest } from '../lib/wiki-server/client.ts';
import { isSid } from '../../packages/id-utils/src/index.ts';

function isMachineId(s: string): boolean {
  return isSid(s);
}

interface PersonnelRecord {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  roleType: string;
  startDate: string | null;
  endDate: string | null;
  isFounder: boolean;
  source: string | null;
  person: { entityId: string | null; slug: string | null; name: string | null };
  organization: { entityId: string | null; slug: string | null; name: string | null };
  personEntityId: string | null;
  personDisplayName: string | null;
  personResolvedName: string | null;
  syncedAt: string;
}

async function fetchAllPersonnel(): Promise<PersonnelRecord[]> {
  const all: PersonnelRecord[] = [];
  let offset = 0;
  while (true) {
    const r = await apiRequest<{ personnel: PersonnelRecord[]; total: number }>(
      'GET',
      `/api/personnel/all?limit=200&offset=${offset}`,
    );
    if (!r.ok) {
      console.error('Failed to fetch personnel:', r.error);
      break;
    }
    all.push(...r.data.personnel);
    if (all.length >= r.data.total) break;
    offset += 200;
  }
  return all;
}

function getDisplayName(r: PersonnelRecord): string | null {
  return r.person?.name ?? r.personResolvedName ?? r.personDisplayName;
}

function hasDisplayableName(r: PersonnelRecord): boolean {
  const name = getDisplayName(r);
  if (!name) return false;
  if (isMachineId(name)) return false;
  // Names with digits mixed in but no spaces are likely IDs
  if (name.length <= 15 && !name.includes(' ') && /\d/.test(name) && /[A-Z]/.test(name)) return false;
  return true;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Personnel cleanup ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);
  console.log('Fetching all personnel records...');

  const all = await fetchAllPersonnel();
  console.log(`Total records: ${all.length}`);

  // ── Category 1a: Fabricated stableId — personId looks like a stableId but doesn't
  //    match any entity AND has no human-readable name from any source.
  //    The !hasDisplayableName guard prevents deleting records that are merely
  //    waiting for entity resolution (e.g., synced before their person entity).
  const fabricatedId = all.filter(
    (r) => STABLE_ID_RE.test(r.personId) && !r.personEntityId && !hasDisplayableName(r),
  );
  console.log(`\nRecords with fabricated personId (stableId, no entity, no name): ${fabricatedId.length}`);

  // ── Category 1b: No displayable name (catches remaining junk) ──
  const fabricatedIdSet = new Set(fabricatedId.map((r) => r.id));
  const noName = all.filter((r) => !hasDisplayableName(r) && !fabricatedIdSet.has(r.id));
  console.log(`Records with no displayable name (additional): ${noName.length}`);

  // ── Category 2: Duplicates (same person + same org) ──
  const seen = new Map<string, PersonnelRecord>();
  const duplicates: PersonnelRecord[] = [];
  for (const r of all) {
    // Skip records we're already deleting for no name
    if (!hasDisplayableName(r)) continue;

    const name = getDisplayName(r)!.toLowerCase();
    const orgId = r.organization?.entityId ?? r.organizationId;
    const key = `${name}::${orgId}`;

    if (seen.has(key)) {
      // Keep the one with more data (prefer entity-resolved, then newer sync)
      const existing = seen.get(key)!;
      const existingScore = (existing.personEntityId ? 10 : 0) + (existing.startDate ? 1 : 0) + (existing.endDate ? 1 : 0);
      const newScore = (r.personEntityId ? 10 : 0) + (r.startDate ? 1 : 0) + (r.endDate ? 1 : 0);

      if (newScore > existingScore) {
        // New one is better, mark old one as duplicate
        duplicates.push(existing);
        seen.set(key, r);
      } else {
        duplicates.push(r);
      }
    } else {
      seen.set(key, r);
    }
  }
  console.log(`Duplicate records: ${duplicates.length}`);

  // ── Summary ──
  const toDelete = [...fabricatedId, ...noName, ...duplicates];
  const toDeleteIds = [...new Set(toDelete.map((r) => r.id))];
  console.log(`\nTotal to delete: ${toDeleteIds.length}`);
  console.log(`  - Fabricated stableIds: ${fabricatedId.length}`);
  console.log(`  - No displayable name: ${noName.length}`);
  console.log(`  - Duplicates: ${duplicates.length}`);
  console.log(`Will remain: ${all.length - toDeleteIds.length}`);

  // Show samples
  console.log('\n── Sample deletions (fabricated stableId) ──');
  for (const r of fabricatedId.slice(0, 10)) {
    const org = r.organization?.name ?? r.organizationId;
    console.log(`  ${r.id} | personId=${r.personId} | ${r.role} at ${org}`);
  }

  console.log('\n── Sample deletions (no name) ──');
  for (const r of noName.slice(0, 10)) {
    const org = r.organization?.name ?? r.organizationId;
    console.log(`  ${r.id} | personId=${r.personId} | ${r.role} at ${org}`);
  }

  console.log('\n── Sample deletions (duplicates) ──');
  for (const r of duplicates.slice(0, 10)) {
    const name = getDisplayName(r);
    const org = r.organization?.name ?? r.organizationId;
    console.log(`  ${r.id} | ${name} | ${r.role} (${r.roleType}) at ${org}`);
  }

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to delete.');
    return;
  }

  // ── Delete in batches ──
  const BATCH_SIZE = 100;
  let totalDeleted = 0;
  for (let i = 0; i < toDeleteIds.length; i += BATCH_SIZE) {
    const batch = toDeleteIds.slice(i, i + BATCH_SIZE);
    const result = await apiRequest<{ deleted: number }>(
      'POST',
      '/api/personnel/delete',
      { ids: batch, reason: 'Cleanup: unresolved stableId names and duplicate records' },
    );
    if (result.ok) {
      totalDeleted += result.data.deleted;
      console.log(`  Deleted batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.data.deleted} records`);
    } else {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, result.error);
    }
  }

  console.log(`\nDone. Deleted ${totalDeleted} records.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
