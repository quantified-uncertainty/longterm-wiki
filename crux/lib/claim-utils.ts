/**
 * Parse a raw value (number, string, or unknown) into a finite number.
 * Handles string-encoded numbers like "7300000000" or "7,300,000,000".
 * Returns undefined if the value cannot be parsed.
 */
export function parseNumericValue(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    if (isFinite(n)) return n;
  }
  return undefined;
}

/** Valid claim types — expanded taxonomy from claim-first architecture. */
export const VALID_CLAIM_TYPES = [
  'factual', 'evaluative', 'causal', 'historical',
  'numeric', 'consensus', 'speculative', 'relational',
] as const;

export type ClaimTypeValue = (typeof VALID_CLAIM_TYPES)[number];

/** Map from granular claimType → high-level claimCategory. */
export function claimTypeToCategory(claimType: ClaimTypeValue): string {
  switch (claimType) {
    case 'factual':
    case 'numeric':
    case 'historical':
      return 'factual';
    case 'evaluative':
      return 'opinion';
    case 'causal':
      return 'analytical';
    case 'consensus':
      return 'opinion';
    case 'speculative':
      return 'speculative';
    case 'relational':
      return 'relational';
    default:
      return 'factual';
  }
}

// ---------------------------------------------------------------------------
// Claim deduplication utilities
// ---------------------------------------------------------------------------

/**
 * Normalize claim text for comparison: lowercase, collapse whitespace,
 * strip trailing punctuation.
 */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/, '');
}

/**
 * Compute Jaccard similarity between two sets of words.
 * Returns a value in [0, 1].
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if a new claim is a duplicate of an existing claim.
 *
 * Returns true if:
 * - Exact match after normalization
 * - One is a substring of the other (>80% length overlap)
 * - Jaccard word-set similarity >= threshold (default 0.75)
 */
export function isClaimDuplicate(
  newText: string,
  existingText: string,
  threshold = 0.75,
): boolean {
  const normNew = normalizeClaimText(newText);
  const normExisting = normalizeClaimText(existingText);

  // Exact match
  if (normNew === normExisting) return true;

  // Substring containment with >80% length overlap
  const shorter = normNew.length <= normExisting.length ? normNew : normExisting;
  const longer = normNew.length <= normExisting.length ? normExisting : normNew;
  if (longer.includes(shorter) && shorter.length / longer.length > 0.6) {
    return true;
  }

  // Jaccard word-set similarity
  const wordsNew = new Set(normNew.split(' ').filter(w => w.length > 0));
  const wordsExisting = new Set(normExisting.split(' ').filter(w => w.length > 0));
  return jaccardSimilarity(wordsNew, wordsExisting) >= threshold;
}

/**
 * Filter a list of new claims against existing claim texts, removing duplicates.
 * Returns only the claims that are NOT duplicates of any existing claim.
 */
export function deduplicateClaims<T extends { claimText: string }>(
  newClaims: T[],
  existingTexts: string[],
  threshold = 0.75,
): { unique: T[]; duplicateCount: number } {
  const unique: T[] = [];
  let duplicateCount = 0;

  for (const claim of newClaims) {
    const isDup = existingTexts.some(existing =>
      isClaimDuplicate(claim.claimText, existing, threshold),
    );
    if (isDup) {
      duplicateCount++;
    } else {
      unique.push(claim);
    }
  }

  return { unique, duplicateCount };
}
