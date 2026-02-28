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

export type ClaimCategoryValue = 'factual' | 'opinion' | 'analytical' | 'speculative' | 'relational';

/** Map from granular claimType → high-level claimCategory. */
export function claimTypeToCategory(claimType: ClaimTypeValue): ClaimCategoryValue {
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
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute Jaccard word-level similarity between two text strings.
 * Normalizes both strings first, then computes Jaccard on word sets.
 * Returns a value in [0, 1].
 */
export function jaccardWordSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeClaimText(a).split(' ').filter(w => w.length > 0));
  const wordsB = new Set(normalizeClaimText(b).split(' ').filter(w => w.length > 0));
  return jaccardSimilarity(wordsA, wordsB);
}

// Jaccard threshold for word-set duplicate detection.
// 0.75 means claims must share 75% of their word vocabulary (by Jaccard) to be
// considered duplicates. Empirically this catches paraphrases ("GPT-4 scores 86%"
// vs "GPT-4 achieves an 86% score") while allowing genuinely distinct claims that
// happen to share common terms. Lower values (e.g. 0.6) cause false positives on
// topic-adjacent claims; higher values (e.g. 0.9) miss obvious paraphrases.
const JACCARD_DEDUP_THRESHOLD = 0.75;

// Minimum ratio of shorter/longer text length for substring containment to count
// as a duplicate. 0.6 prevents a short fragment ("GPT-4") from matching a full
// sentence that happens to contain it. Raising this toward 1.0 would require
// near-identical length; lowering it risks false positives on short substrings.
const SUBSTRING_OVERLAP_RATIO = 0.6;

/**
 * Check if a new claim is a duplicate of an existing claim.
 *
 * Returns true if:
 * - Exact match after normalization
 * - One is a substring of the other with length ratio > SUBSTRING_OVERLAP_RATIO (0.6)
 * - Jaccard word-set similarity >= threshold (default JACCARD_DEDUP_THRESHOLD = 0.75)
 *
 * The threshold parameter overrides JACCARD_DEDUP_THRESHOLD, primarily for tests.
 */
export function isClaimDuplicate(
  newText: string,
  existingText: string,
  threshold = JACCARD_DEDUP_THRESHOLD,
): boolean {
  const normNew = normalizeClaimText(newText);
  const normExisting = normalizeClaimText(existingText);

  // Exact match
  if (normNew === normExisting) return true;

  // Substring containment: only flag as duplicate if the shorter string is at
  // least SUBSTRING_OVERLAP_RATIO (0.6) of the longer's length. This avoids
  // short fragments triggering false-positive deduplication.
  const shorter = normNew.length <= normExisting.length ? normNew : normExisting;
  const longer = normNew.length <= normExisting.length ? normExisting : normNew;
  if (longer.includes(shorter) && shorter.length / longer.length > SUBSTRING_OVERLAP_RATIO) {
    return true;
  }

  // Jaccard word-set similarity: treats claims as bags of words and measures
  // overlap. At 0.75 this catches paraphrases while tolerating topical overlap.
  const wordsNew = new Set(normNew.split(' ').filter(w => w.length > 0));
  const wordsExisting = new Set(normExisting.split(' ').filter(w => w.length > 0));
  return jaccardSimilarity(wordsNew, wordsExisting) >= threshold;
}

/**
 * Filter a list of new claims against existing claim texts, removing duplicates.
 * Returns only the claims that are NOT duplicates of any existing claim.
 *
 * `threshold` defaults to JACCARD_DEDUP_THRESHOLD (0.75). Pass a lower value
 * to be more aggressive about deduplication; pass a higher value to be more
 * conservative (fewer merges, more duplicates retained).
 */
export function deduplicateClaims<T extends { claimText: string }>(
  newClaims: T[],
  existingTexts: string[],
  threshold = JACCARD_DEDUP_THRESHOLD,
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
