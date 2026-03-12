import type { RawGrant } from "./types.ts";

export interface DuplicateGroup {
  key: string;           // normalized dedup key
  grants: RawGrant[];    // the duplicate grants
  confidence: number;    // 0-1 confidence they're truly duplicates
}

// Common suffixes/words to strip from organization names for fuzzy matching
const STRIP_SUFFIXES = [
  /\b(inc\.?|incorporated|ltd\.?|limited|llc|l\.l\.c\.?|corp\.?|corporation|co\.?|company)\b/gi,
  /\b(foundations?|funds?|trusts?|institutes?|associations?|society|societies|groups?|centers?|centres?)\b/gi,
  /\b(the|a|an|of|for|and|&)\b/gi,
  /[.,\-'"()]/g,
];

/**
 * Normalize a grantee name for fuzzy matching.
 * Lowercase, strip common legal suffixes, collapse whitespace.
 */
export function normalizeGranteeName(name: string): string {
  let normalized = name.toLowerCase().trim();

  for (const pattern of STRIP_SUFFIXES) {
    normalized = normalized.replace(pattern, "");
  }

  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Extract year-month from a date string for approximate matching.
 * Returns "YYYY-MM" or "" if no date.
 */
export function extractYearMonth(date: string | null): string {
  if (!date) return "";
  // Handle YYYY-MM-DD, YYYY/MM/DD, etc.
  const match = date.match(/(\d{4})[/-](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}`;
  }
  return "";
}

/**
 * Check if two amounts are within tolerance of each other.
 * Default tolerance is 5%.
 */
export function amountsMatch(a: number | null, b: number | null, tolerance = 0.05): boolean {
  // Both null = match (unknown amounts)
  if (a === null && b === null) return true;
  // One null, one not = no match
  if (a === null || b === null) return false;
  // Both zero
  if (a === 0 && b === 0) return true;

  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;

  const diff = Math.abs(a - b) / max;
  return diff <= tolerance;
}

/**
 * Generate a fuzzy dedup key from a grant.
 * Uses normalized grantee name + approximate amount bucket + year-month.
 */
export function dedupeKey(grant: RawGrant): string {
  const name = normalizeGranteeName(grant.granteeName);
  const ym = extractYearMonth(grant.date);

  // Bucket amount to nearest 10,000 to handle minor differences.
  // The coarse bucket ensures near-boundary amounts end up in the same group.
  // Fine-grained matching is done via amountsMatch in the validation step.
  const amountBucket = grant.amount !== null
    ? Math.round(grant.amount / 10000).toString()
    : "null";

  return `${name}|${amountBucket}|${ym}`;
}

/**
 * Compute confidence score for a group of potential duplicates.
 * Higher = more likely truly duplicates.
 */
function computeConfidence(grants: RawGrant[]): number {
  if (grants.length < 2) return 0;

  let score = 0;

  // All from different sources is a strong signal
  const sources = new Set(grants.map(g => g.source));
  if (sources.size === grants.length) {
    score += 0.3;
  } else {
    // Some from same source = less likely cross-source duplicates
    score += 0.1;
  }

  // Exact amount match is a strong signal
  const amounts = grants.map(g => g.amount).filter(a => a !== null) as number[];
  if (amounts.length >= 2) {
    const allExact = amounts.every(a => a === amounts[0]);
    if (allExact) {
      score += 0.3;
    } else {
      // Check if within tolerance
      const allClose = amounts.every(a => amountsMatch(a, amounts[0]));
      if (allClose) {
        score += 0.2;
      }
    }
  }

  // Name similarity (exact normalized names)
  const normalizedNames = grants.map(g => normalizeGranteeName(g.granteeName));
  const allSameName = normalizedNames.every(n => n === normalizedNames[0]);
  if (allSameName) {
    score += 0.2;
  }

  // Same year-month
  const yearMonths = grants.map(g => extractYearMonth(g.date)).filter(ym => ym !== "");
  if (yearMonths.length >= 2) {
    const allSameYM = yearMonths.every(ym => ym === yearMonths[0]);
    if (allSameYM) {
      score += 0.2;
    }
  }

  return Math.min(score, 1.0);
}

/**
 * Detect likely cross-source duplicates among a set of grants.
 * Groups by fuzzy key, then validates groups with amount tolerance.
 * Only returns groups with grants from multiple sources.
 */
export function detectDuplicates(grants: RawGrant[]): DuplicateGroup[] {
  // Group by fuzzy key
  const groups = new Map<string, RawGrant[]>();
  for (const grant of grants) {
    const key = dedupeKey(grant);
    const existing = groups.get(key) || [];
    existing.push(grant);
    groups.set(key, existing);
  }

  const duplicateGroups: DuplicateGroup[] = [];

  for (const [key, groupGrants] of groups) {
    // Only consider groups with multiple grants
    if (groupGrants.length < 2) continue;

    // Only consider cross-source duplicates
    const sources = new Set(groupGrants.map(g => g.source));
    if (sources.size < 2) continue;

    // Validate amounts are within tolerance
    // Sub-group by amount tolerance if needed
    const validatedGrants = validateAmountGroups(groupGrants);
    for (const subGroup of validatedGrants) {
      if (subGroup.length < 2) continue;

      const subSources = new Set(subGroup.map(g => g.source));
      if (subSources.size < 2) continue;

      const confidence = computeConfidence(subGroup);
      if (confidence >= 0.3) {
        duplicateGroups.push({
          key,
          grants: subGroup,
          confidence,
        });
      }
    }
  }

  // Sort by confidence descending
  return duplicateGroups.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Sub-group grants by amount tolerance.
 * Grants whose amounts differ by more than the tolerance are split into
 * separate groups. This handles cases where the dedup key's amount bucket
 * groups together grants that are actually different.
 */
function validateAmountGroups(grants: RawGrant[]): RawGrant[][] {
  if (grants.length <= 1) return [grants];

  // Sort by amount to make grouping easier
  const sorted = [...grants].sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0));
  const subGroups: RawGrant[][] = [];
  let currentGroup: RawGrant[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    // Check if this grant's amount matches any in the current group
    const matchesGroup = currentGroup.some(g => amountsMatch(g.amount, current.amount));

    if (matchesGroup) {
      currentGroup.push(current);
    } else {
      subGroups.push(currentGroup);
      currentGroup = [current];
    }
  }
  subGroups.push(currentGroup);

  return subGroups;
}

/**
 * Choose the "best" grant from a duplicate group.
 * Prefers grants with more detail (description, focus area, source URL).
 */
export function chooseBestGrant(group: DuplicateGroup): RawGrant {
  if (group.grants.length === 1) return group.grants[0];

  return group.grants.reduce((best, current) => {
    const bestScore = grantDetailScore(best);
    const currentScore = grantDetailScore(current);
    return currentScore > bestScore ? current : best;
  });
}

/**
 * Score a grant by how much detail it has.
 * Higher score = more detailed / better quality.
 */
function grantDetailScore(grant: RawGrant): number {
  let score = 0;

  // Has a description
  if (grant.description && grant.description.length > 0) {
    score += 2;
    // Longer descriptions are better
    score += Math.min(grant.description.length / 500, 1);
  }

  // Has a focus area
  if (grant.focusArea && grant.focusArea.length > 0) {
    score += 1;
  }

  // Has an amount
  if (grant.amount !== null && grant.amount > 0) {
    score += 1;
  }

  // Has a date
  if (grant.date) {
    score += 1;
  }

  // Has a source URL
  if (grant.sourceUrl) {
    score += 1;
  }

  // Has a matched entity
  if (grant.granteeId) {
    score += 1;
  }

  // Has a meaningful name (not just grantee name repeated)
  if (grant.name && grant.name !== grant.granteeName && grant.name.length > 10) {
    score += 1;
  }

  return score;
}

/**
 * Deduplicate grants, keeping the best version of each duplicate group.
 * Returns the deduplicated set of grants.
 */
export function deduplicateGrants(grants: RawGrant[]): { deduplicated: RawGrant[]; removed: number } {
  const duplicateGroups = detectDuplicates(grants);

  if (duplicateGroups.length === 0) {
    return { deduplicated: grants, removed: 0 };
  }

  // Build a set of grants to remove (all but the best in each group)
  const toRemove = new Set<RawGrant>();

  for (const group of duplicateGroups) {
    const best = chooseBestGrant(group);
    for (const grant of group.grants) {
      if (grant !== best) {
        toRemove.add(grant);
      }
    }
  }

  const deduplicated = grants.filter(g => !toRemove.has(g));
  return { deduplicated, removed: toRemove.size };
}

/**
 * Print duplicate analysis to console.
 */
export function printDuplicateAnalysis(grants: RawGrant[]): void {
  const groups = detectDuplicates(grants);

  if (groups.length === 0) {
    console.log("\nCross-source duplicates: none detected");
    return;
  }

  const totalDuplicates = groups.reduce((sum, g) => sum + g.grants.length - 1, 0);
  console.log(`\nCross-source duplicates: ${groups.length} groups (${totalDuplicates} duplicates)`);

  // Show top 10 groups
  const showCount = Math.min(groups.length, 10);
  console.log(`\nTop ${showCount} duplicate groups:`);

  for (const group of groups.slice(0, showCount)) {
    const amounts = group.grants.map(g =>
      g.amount !== null ? `$${(g.amount / 1e3).toFixed(0)}K` : "unknown"
    ).join(", ");

    console.log(`  [${(group.confidence * 100).toFixed(0)}% confidence] ${group.grants[0].granteeName}`);
    console.log(`    Sources: ${group.grants.map(g => g.source).join(", ")}`);
    console.log(`    Amounts: ${amounts}`);
    console.log(`    Dates: ${group.grants.map(g => g.date || "unknown").join(", ")}`);
  }

  if (groups.length > showCount) {
    console.log(`  ... and ${groups.length - showCount} more groups`);
  }
}
