/**
 * Span-verification for system-card extractions (QUA-690).
 *
 * For every non-null field the extractor returned, check that its excerpt
 * appears in the source text. Fields without a grounded excerpt are
 * dropped to null and logged — treating them as hallucinations per
 * `.claude/rules/implementation-quality.md` (adversarial inputs).
 *
 * Matching tiers (cheap → expensive):
 *   1. exact substring match (case-insensitive)
 *   2. whitespace-collapsed match (PDFs are whitespace-noisy)
 *   3. token-Jaccard similarity on the excerpt vs. a sliding window
 *
 * Fuzzy threshold defaults to 0.7 Jaccard on 3+ token excerpts. Below
 * that, treat as unverified.
 */

import type { ExtractedCard, ExtractedEvalScore, ExtractedThirdPartyEval } from './extract-system-card.ts';

export interface VerifyOptions {
  /** Jaccard threshold for token-based fuzzy match. Default 0.7. */
  jaccardThreshold?: number;
  /** Ignore excerpts this short (noise). Default 8 chars. */
  minExcerptChars?: number;
}

export interface FieldVerdict {
  verified: boolean;
  /** 1.0 exact match, 0.9 whitespace-normalized, 0.0-1.0 Jaccard. */
  confidence: number;
  /** Reason when verified=false. */
  reason?: 'no-excerpt' | 'excerpt-too-short' | 'below-threshold' | 'not-found';
}

export interface VerifyResult {
  /** The card with unverified fields coerced to null. */
  verifiedCard: ExtractedCard;
  /** Per-field verdicts, including drops. Keys are field names. */
  verdicts: Record<string, FieldVerdict>;
  /** Count of fields that were initially non-null but failed verification. */
  droppedFields: string[];
  /** Count of fields that had no excerpt at all. */
  ungroundedFields: string[];
  /** Overall per-field confidence jsonb for the `extraction_confidence` column. */
  confidenceMap: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Text normalization helpers
// ---------------------------------------------------------------------------

/** Lowercase + collapse all whitespace to single spaces. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Split into word tokens, lowercase, drop short/empty. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\w.]+/)
    .filter((t) => t.length > 1);
}

/** Jaccard similarity over token sets. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Check whether an excerpt appears (exact or fuzzy) in the source text.
 * Returns a `FieldVerdict` with `confidence` in [0, 1].
 */
export function verifyExcerpt(
  excerpt: string,
  sourceText: string,
  options: VerifyOptions = {},
): FieldVerdict {
  const { jaccardThreshold = 0.7, minExcerptChars = 8 } = options;

  if (!excerpt || excerpt.trim().length === 0) {
    return { verified: false, confidence: 0, reason: 'no-excerpt' };
  }
  if (excerpt.length < minExcerptChars) {
    return { verified: false, confidence: 0, reason: 'excerpt-too-short' };
  }

  // Tier 1: raw case-insensitive substring.
  if (sourceText.toLowerCase().includes(excerpt.toLowerCase())) {
    return { verified: true, confidence: 1 };
  }

  // Tier 2: whitespace-normalized.
  const normExcerpt = normalize(excerpt);
  const normSource = normalize(sourceText);
  if (normSource.includes(normExcerpt)) {
    return { verified: true, confidence: 0.9 };
  }

  // Tier 3: Jaccard over tokens. Sliding window = excerpt length in tokens.
  const excerptTokens = tokenize(excerpt);
  if (excerptTokens.length < 3) {
    return { verified: false, confidence: 0, reason: 'excerpt-too-short' };
  }

  const sourceTokens = tokenize(sourceText);
  const windowSize = Math.max(excerptTokens.length, 6);

  // Step by half-window to keep cost bounded on huge sources.
  const step = Math.max(1, Math.floor(windowSize / 2));
  let best = 0;
  for (let i = 0; i + windowSize <= sourceTokens.length; i += step) {
    const window = sourceTokens.slice(i, i + windowSize);
    const sim = jaccard(excerptTokens, window);
    if (sim > best) best = sim;
    if (best >= 0.99) break;
  }

  if (best >= jaccardThreshold) {
    return { verified: true, confidence: best };
  }
  return { verified: false, confidence: best, reason: 'not-found' };
}

// ---------------------------------------------------------------------------
// Card-level verification
// ---------------------------------------------------------------------------

/**
 * Fields that carry per-row excerpts internally (eval_scores_cited,
 * third_party_evals). Verification walks each row.
 */
const LIST_FIELDS = ['eval_scores_cited', 'third_party_evals'] as const;

/**
 * Fields that are metadata/free-form and don't need span verification.
 * `notes` is agent commentary; `safety_framework` is a controlled vocab;
 * excerpts for URLs are rarely useful.
 */
const METADATA_FIELDS = new Set([
  'notes',
  'safety_framework', // controlled vocab — verified by the lab hint itself
  'system_prompt_url',
  'usage_policy_url',
]);

export function verifyExtractedCard(
  card: ExtractedCard,
  sourceText: string,
  options: VerifyOptions = {},
): VerifyResult {
  const verdicts: Record<string, FieldVerdict> = {};
  const confidenceMap: Record<string, number> = {};
  const droppedFields: string[] = [];
  const ungroundedFields: string[] = [];

  // Work on a copy we can mutate.
  const verifiedCard: ExtractedCard = { ...card };
  const verifiedAsRec = verifiedCard as unknown as Record<string, unknown>;

  // Walk scalar/object fields that have values.
  for (const [field, value] of Object.entries(card)) {
    if (field === 'excerpts') continue;
    if (LIST_FIELDS.includes(field as (typeof LIST_FIELDS)[number])) continue;
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) {
      verifiedAsRec[field] = null;
      continue;
    }

    if (METADATA_FIELDS.has(field)) {
      // Still record a verdict so downstream can see these were skipped.
      verdicts[field] = { verified: true, confidence: 0.5 };
      confidenceMap[field] = 0.5;
      continue;
    }

    const excerpt = card.excerpts[field] ?? '';
    const verdict = verifyExcerpt(excerpt, sourceText, options);
    verdicts[field] = verdict;
    confidenceMap[field] = Number(verdict.confidence.toFixed(2));

    if (!verdict.verified) {
      // Hallucination guard: null the field.
      verifiedAsRec[field] = null;
      droppedFields.push(field);
      if (verdict.reason === 'no-excerpt' || verdict.reason === 'excerpt-too-short') {
        ungroundedFields.push(field);
      }
    }
  }

  // Walk list-shaped fields row-by-row.
  if (card.eval_scores_cited) {
    const verifiedScores: ExtractedEvalScore[] = [];
    for (let i = 0; i < card.eval_scores_cited.length; i++) {
      const row: ExtractedEvalScore = card.eval_scores_cited[i];
      const key = `eval_scores_cited[${i}:${row.benchmark}]`;
      const excerpt = row.excerpt ?? '';
      const verdict = verifyExcerpt(excerpt, sourceText, options);
      verdicts[key] = verdict;
      confidenceMap[key] = Number(verdict.confidence.toFixed(2));
      if (verdict.verified) {
        verifiedScores.push(row);
      } else {
        droppedFields.push(key);
      }
    }
    verifiedCard.eval_scores_cited = verifiedScores.length > 0 ? verifiedScores : null;
  }

  if (card.third_party_evals) {
    const verifiedEvals: ExtractedThirdPartyEval[] = [];
    for (let i = 0; i < card.third_party_evals.length; i++) {
      const row: ExtractedThirdPartyEval = card.third_party_evals[i];
      const key = `third_party_evals[${i}:${row.evaluator}]`;
      const excerpt = row.excerpt ?? '';
      const verdict = verifyExcerpt(excerpt, sourceText, options);
      verdicts[key] = verdict;
      confidenceMap[key] = Number(verdict.confidence.toFixed(2));
      if (verdict.verified) {
        verifiedEvals.push(row);
      } else {
        droppedFields.push(key);
      }
    }
    verifiedCard.third_party_evals = verifiedEvals.length > 0 ? verifiedEvals : null;
  }

  return {
    verifiedCard,
    verdicts,
    droppedFields,
    ungroundedFields,
    confidenceMap,
  };
}
