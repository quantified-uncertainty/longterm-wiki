/**
 * Fuzzy Matching — string similarity utilities for deterministic row-matching.
 *
 * Used to compare grant record fields against source data. Handles name
 * normalization, edit distance, amount tolerance, and date granularity.
 *
 * Part of Phase 3: Data Source Resources (Discussion #3567).
 */

/**
 * Normalize an organization name for comparison.
 * Strips common suffixes, lowercases, normalizes Unicode, collapses whitespace.
 */
export function normalizeOrgName(name: string): string {
  return name
    .normalize('NFC')
    // Strip diacritics for ASCII comparison
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    // Lowercase
    .toLowerCase()
    // Strip common org suffixes
    .replace(/\b(inc\.?|llc\.?|corp\.?|corporation|ltd\.?|limited|plc\.?|gmbh|foundation|the|of|for)\b/gi, '')
    // Strip parenthetical disambiguation
    .replace(/\([^)]*\)/g, '')
    // Collapse whitespace
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein edit distance between two strings.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Check if two names match, using normalization and edit distance.
 * @param threshold - Maximum edit distance as a fraction of the longer string (default: 0.3)
 */
export function nameMatches(a: string, b: string, threshold = 0.3): boolean {
  const normA = normalizeOrgName(a);
  const normB = normalizeOrgName(b);

  if (normA === normB) return true;

  // For very short normalized strings, require exact match
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen < 4) return normA === normB;

  const dist = editDistance(normA, normB);
  return dist / maxLen <= threshold;
}

/**
 * Check if two amounts match within tolerance.
 * Exact match for amounts under $1000, 0.1% tolerance for larger amounts.
 */
export function amountMatches(a: number | null, b: number | null, tolerancePct = 0.001): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  if (a === 0 && b === 0) return true;

  const diff = Math.abs(a - b);
  const maxVal = Math.max(Math.abs(a), Math.abs(b));

  // For small amounts, require exact match (within $1)
  if (maxVal < 1000) return diff <= 1;

  return diff / maxVal <= tolerancePct;
}

/**
 * Check if two dates match with appropriate granularity.
 * - "2018" matches "2018-07" matches "2018-07-15" (year is sufficient)
 * - "2018-07" matches "2018-07-15" (month is sufficient)
 * - Tolerates format differences ("July 2018" should have been parsed to ISO already)
 */
export function dateMatches(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a === b) return true;

  // Extract year and optional month from ISO-ish dates
  const parseDate = (d: string): { year: number; month?: number } | null => {
    const m = d.match(/^(\d{4})(?:-(\d{2}))?/);
    if (!m) return null;
    return { year: parseInt(m[1], 10), month: m[2] ? parseInt(m[2], 10) : undefined };
  };

  const dateA = parseDate(a);
  const dateB = parseDate(b);
  if (!dateA || !dateB) return false;

  // Year must match
  if (dateA.year !== dateB.year) return false;

  // If both have months, they must match
  if (dateA.month != null && dateB.month != null) {
    return dateA.month === dateB.month;
  }

  // One has month, other doesn't — year match is sufficient
  return true;
}
