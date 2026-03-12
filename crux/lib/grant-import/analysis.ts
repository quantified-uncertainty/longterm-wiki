import type { RawGrant, SyncGrant } from "./types.ts";

export function printMatchStats(grants: RawGrant[]): void {
  const matched = grants.filter((g) => g.granteeId !== null);
  const unmatched = grants.filter((g) => g.granteeId === null);

  console.log(`Entity matching:`);
  console.log(`  Matched: ${matched.length} (${grants.length > 0 ? ((matched.length / grants.length) * 100).toFixed(1) : 0}%)`);
  console.log(`  Unmatched: ${unmatched.length} (stored as display names)\n`);

  const granteeNames = new Set(grants.map((g) => g.granteeName));
  const matchedNames = new Set(matched.map((g) => g.granteeName));
  console.log(`Unique grantee names: ${granteeNames.size}`);
  console.log(`Matched to entities: ${matchedNames.size}`);
}

export function printTopUnmatched(grants: RawGrant[], limit = 30): void {
  const unmatched = grants.filter((g) => g.granteeId === null);
  const unmatchedByOrg = new Map<string, { total: number; count: number }>();
  for (const g of unmatched) {
    const entry = unmatchedByOrg.get(g.granteeName) || { total: 0, count: 0 };
    entry.total += g.amount || 0;
    entry.count++;
    unmatchedByOrg.set(g.granteeName, entry);
  }

  const sorted = [...unmatchedByOrg.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit);

  console.log(`\nTop ${limit} unmatched grantees by amount:`);
  for (const [name, data] of sorted) {
    console.log(
      `  $${(data.total / 1e6).toFixed(1)}M (${data.count} grants) — ${name}`
    );
  }
}

export function checkIdCollisions(syncGrants: SyncGrant[]): void {
  const idSet = new Set<string>();
  let collisions = 0;
  for (const g of syncGrants) {
    if (idSet.has(g.id)) collisions++;
    idSet.add(g.id);
  }
  console.log(`\nGenerated ${idSet.size} unique IDs (${collisions} collisions → would be deduped)`);
}

export function printByFunder(syncGrants: SyncGrant[]): void {
  const byFunder = new Map<string, number>();
  for (const g of syncGrants) {
    byFunder.set(g.organizationId, (byFunder.get(g.organizationId) || 0) + 1);
  }
  console.log(`\nGrants by funder entity:`);
  for (const [id, count] of [...byFunder.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id}: ${count} grants`);
  }
}
