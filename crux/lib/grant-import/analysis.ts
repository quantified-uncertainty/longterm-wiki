import type { RawGrant, SyncGrant } from "./types.ts";
import { convertToUSD, formatAmount, isSupportedCurrency } from "./currency.ts";

// --- Data types ---

export interface MatchStats {
  total: number;
  matched: number;
  unmatched: number;
  matchRate: number; // 0-1
  uniqueGranteeNames: number;
  matchedGranteeNames: number;
}

export interface UnmatchedGrantee {
  name: string;
  /** Total amount converted to USD for ranking. */
  totalAmountUSD: number;
  count: number;
}

export interface IdCollisions {
  uniqueIds: number;
  collisions: number;
}

export interface FunderBreakdown {
  organizationId: string;
  count: number;
}

// --- Helpers ---

/** Convert a raw grant's amount to USD, using the grant's currency field. */
function rawAmountToUSD(grant: RawGrant): number {
  if (grant.amount == null) return 0;
  const currency = (grant.currency ?? "USD").trim().toUpperCase();
  if (!isSupportedCurrency(currency)) return 0;
  return convertToUSD(grant.amount, currency);
}

// --- Data functions ---

export function getMatchStats(grants: RawGrant[]): MatchStats {
  const matched = grants.filter((g) => g.granteeId !== null);
  const unmatched = grants.filter((g) => g.granteeId === null);
  const granteeNames = new Set(grants.map((g) => g.granteeName));
  const matchedNames = new Set(matched.map((g) => g.granteeName));

  return {
    total: grants.length,
    matched: matched.length,
    unmatched: unmatched.length,
    matchRate: grants.length > 0 ? matched.length / grants.length : 0,
    uniqueGranteeNames: granteeNames.size,
    matchedGranteeNames: matchedNames.size,
  };
}

export function getTopUnmatched(grants: RawGrant[], limit = 30): UnmatchedGrantee[] {
  const unmatched = grants.filter((g) => g.granteeId === null);
  const unmatchedByOrg = new Map<string, { totalUSD: number; count: number }>();
  for (const g of unmatched) {
    const entry = unmatchedByOrg.get(g.granteeName) || { totalUSD: 0, count: 0 };
    entry.totalUSD += rawAmountToUSD(g);
    entry.count++;
    unmatchedByOrg.set(g.granteeName, entry);
  }

  return [...unmatchedByOrg.entries()]
    .sort((a, b) => b[1].totalUSD - a[1].totalUSD)
    .slice(0, limit)
    .map(([name, data]) => ({
      name,
      totalAmountUSD: data.totalUSD,
      count: data.count,
    }));
}

export function getIdCollisions(syncGrants: SyncGrant[]): IdCollisions {
  const idSet = new Set<string>();
  let collisions = 0;
  for (const g of syncGrants) {
    if (idSet.has(g.id)) collisions++;
    idSet.add(g.id);
  }
  return { uniqueIds: idSet.size, collisions };
}

export function getByFunder(syncGrants: SyncGrant[]): FunderBreakdown[] {
  const byFunder = new Map<string, number>();
  for (const g of syncGrants) {
    byFunder.set(g.organizationId, (byFunder.get(g.organizationId) || 0) + 1);
  }
  return [...byFunder.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([organizationId, count]) => ({ organizationId, count }));
}

// --- Print functions (thin wrappers) ---

export function printMatchStats(grants: RawGrant[]): void {
  const stats = getMatchStats(grants);

  console.log(`Entity matching:`);
  console.log(`  Matched: ${stats.matched} (${(stats.matchRate * 100).toFixed(1)}%)`);
  console.log(`  Unmatched: ${stats.unmatched} (stored as display names)\n`);
  console.log(`Unique grantee names: ${stats.uniqueGranteeNames}`);
  console.log(`Matched to entities: ${stats.matchedGranteeNames}`);
}

export function printTopUnmatched(grants: RawGrant[], limit = 30): void {
  const topUnmatched = getTopUnmatched(grants, limit);

  console.log(`\nTop ${limit} unmatched grantees by amount (USD-equivalent):`);
  for (const entry of topUnmatched) {
    console.log(
      `  ${formatAmount(entry.totalAmountUSD, "USD")} (${entry.count} grants) — ${entry.name}`
    );
  }
}

export function checkIdCollisions(syncGrants: SyncGrant[]): void {
  const { uniqueIds, collisions } = getIdCollisions(syncGrants);
  console.log(`\nGenerated ${uniqueIds} unique IDs (${collisions} collisions → would be deduped)`);
}

export function printByFunder(syncGrants: SyncGrant[]): void {
  const breakdown = getByFunder(syncGrants);

  console.log(`\nGrants by funder entity:`);
  for (const entry of breakdown) {
    console.log(`  ${entry.organizationId}: ${entry.count} grants`);
  }
}

export function printProgramMatchStats(grants: RawGrant[]): void {
  const withProgram = grants.filter((g) => g.programId != null);
  const withoutProgram = grants.filter((g) => g.programId == null);
  const rate = grants.length > 0 ? withProgram.length / grants.length : 0;

  console.log(`\nProgram matching:`);
  console.log(`  Matched: ${withProgram.length} (${(rate * 100).toFixed(1)}%)`);
  console.log(`  Unmatched: ${withoutProgram.length}`);

  // Breakdown by program ID
  if (withProgram.length > 0) {
    const byProgram = new Map<string, number>();
    for (const g of withProgram) {
      byProgram.set(g.programId!, (byProgram.get(g.programId!) || 0) + 1);
    }
    console.log(`  Programs used: ${byProgram.size}`);
    for (const [progId, count] of [...byProgram.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${progId}: ${count} grants`);
    }
  }
}
