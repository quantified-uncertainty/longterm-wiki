/**
 * Quote Verification
 *
 * Verifies that an extracted quote actually exists in the source text.
 * Uses three strategies in order of precision:
 *   1. Exact substring match (score: 1.0)
 *   2. Normalized match — collapse whitespace, ignore punctuation (score: 0.95)
 *   3. Fuzzy match — sliding window with Jaccard similarity on word sets (score: 0.0-0.9)
 */

export interface VerificationResult {
  verified: boolean;
  method: 'exact' | 'normalized' | 'fuzzy' | 'none';
  score: number;
  /** Where in the source text the match was found (character offset) */
  matchOffset?: number;
}

/**
 * Normalize text for comparison: lowercase, collapse whitespace, strip punctuation.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // Smart quotes → straight
    .replace(/[\u2013\u2014]/g, '-') // Em/en dash → hyphen
    .replace(/[^\w\s'-]/g, '') // Strip most punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract words from text for fuzzy comparison.
 */
function wordSet(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(/\s+/)
      .filter((w) => w.length > 2), // Skip very short words
  );
}

/**
 * Compute Jaccard similarity between two word sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Verify that a quote exists in the source text.
 *
 * @param quote - The extracted quote to verify
 * @param fullText - The full text of the source document
 * @returns Verification result with method used and confidence score
 */
export function verifyQuoteInSource(
  quote: string,
  fullText: string,
): VerificationResult {
  if (!quote || !fullText) {
    return { verified: false, method: 'none', score: 0 };
  }

  // Strategy 1: Exact substring match
  const exactIdx = fullText.indexOf(quote);
  if (exactIdx !== -1) {
    return { verified: true, method: 'exact', score: 1.0, matchOffset: exactIdx };
  }

  // Strategy 2: Normalized match
  const normalizedQuote = normalize(quote);
  const normalizedText = normalize(fullText);
  const normalizedIdx = normalizedText.indexOf(normalizedQuote);
  if (normalizedIdx !== -1) {
    return { verified: true, method: 'normalized', score: 0.95, matchOffset: normalizedIdx };
  }

  // Strategy 3: Fuzzy match — sliding window over source text
  const quoteWords = wordSet(quote);
  if (quoteWords.size < 3) {
    // Too few words for meaningful fuzzy matching
    return { verified: false, method: 'none', score: 0 };
  }

  const sourceWords = normalize(fullText).split(/\s+/);
  const windowSize = Math.max(quoteWords.size, 10); // At least 10 words per window
  let bestScore = 0;
  let bestOffset = 0;

  // Slide a window across the source text
  for (let i = 0; i <= sourceWords.length - windowSize; i += Math.max(1, Math.floor(windowSize / 4))) {
    const windowWords = new Set(
      sourceWords.slice(i, i + windowSize * 2).filter((w) => w.length > 2),
    );
    const similarity = jaccardSimilarity(quoteWords, windowWords);
    if (similarity > bestScore) {
      bestScore = similarity;
      bestOffset = i;
    }
  }

  // Cap fuzzy score at 0.9 since it's not an exact match
  const fuzzyScore = Math.min(bestScore, 0.9);
  const FUZZY_THRESHOLD = 0.4;

  return {
    verified: fuzzyScore >= FUZZY_THRESHOLD,
    method: fuzzyScore >= FUZZY_THRESHOLD ? 'fuzzy' : 'none',
    score: fuzzyScore,
    matchOffset: fuzzyScore >= FUZZY_THRESHOLD ? bestOffset : undefined,
  };
}
