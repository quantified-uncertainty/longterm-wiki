/**
 * Canonical Hallucination Risk Scorer
 *
 * Single source of truth for hallucination risk scoring. Used by:
 *   - Build-time pipeline (build-data.mjs) for pages.json / frontend display
 *   - Validation-time reporter (validate-hallucination-risk.ts) for editorial triage
 *   - Wiki server API for historical snapshots
 *
 * ## Scoring approach
 *
 * Baseline 40 (all content is AI-generated), with both risk-increasing and
 * risk-decreasing factors. Score is clamped to 0–100.
 *
 * Levels: low ≤30, medium ≤60, high >60
 *
 * ## History
 *
 * Reconciled from two separate scorers (issue #438):
 *   - Build-time scorer: baseline 40, bidirectional adjustments
 *   - Validation-time scorer: baseline 0, penalty accumulation + entity type multiplier
 *
 * The canonical scorer uses the build-time approach (balanced, bidirectional)
 * with additions from the validation scorer (accuracy data, human review).
 */

import {
  assessContentIntegrity,
  computeIntegrityRisk,
  type IntegrityResult,
} from './content-integrity.ts';

// ---------------------------------------------------------------------------
// Constants (exported for tests and consumers)
// ---------------------------------------------------------------------------

/** Baseline risk score — all wiki content is AI-generated */
export const BASELINE_SCORE = 40;

/** Score thresholds for risk level classification */
export const THRESHOLD_LOW = 30;
export const THRESHOLD_MEDIUM = 60;

// --- Entity type categories ---

export const BIOGRAPHICAL_TYPES = new Set(['person', 'organization', 'funder']);
export const FACTUAL_TYPES = new Set(['event', 'historical', 'case-study']);
export const STRUCTURAL_TYPES = new Set([
  'concept', 'approach', 'safety-agenda', 'intelligence-paradigm',
  'crux', 'debate', 'argument',
]);
export const LOW_RISK_FORMATS = new Set(['table', 'diagram', 'index', 'dashboard']);

// --- Factor weights ---

export const WEIGHT_BIOGRAPHICAL = 20;
export const WEIGHT_FACTUAL = 15;
export const WEIGHT_NO_CITATIONS = 15;
export const WEIGHT_LOW_CITATION_DENSITY = 10;
export const WEIGHT_LOW_RIGOR = 10;
export const WEIGHT_LOW_QUALITY = 5;
export const WEIGHT_FEW_EXTERNAL = 5;
export const WEIGHT_NO_HUMAN_REVIEW = 5;
export const WEIGHT_WELL_CITED = -15;
export const WEIGHT_MODERATELY_CITED = -10;
export const WEIGHT_HIGH_RIGOR = -15;
export const WEIGHT_STRUCTURAL = -10;
export const WEIGHT_LOW_RISK_FORMAT = -15;
export const WEIGHT_MINIMAL_CONTENT = -10;
export const WEIGHT_HIGH_QUALITY = -5;
export const WEIGHT_HUMAN_REVIEWED = -5;

// --- Citation density thresholds (per 1000 words) ---

export const CITATION_DENSITY_HIGH = 8;
export const CITATION_DENSITY_MODERATE = 4;
export const CITATION_DENSITY_LOW = 2;

// --- Accuracy risk thresholds ---

export const ACCURACY_MAJORITY_THRESHOLD = 0.5;
export const ACCURACY_MANY_THRESHOLD = 0.3;
export const WEIGHT_ACCURACY_MAJORITY = 20;
export const WEIGHT_ACCURACY_MANY = 10;
export const WEIGHT_ACCURACY_SOME = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input data for the canonical scorer */
export interface RiskInput {
  /** Canonical entity type (after alias resolution) */
  entityType: string | null;
  /** Total word count of page body */
  wordCount: number;
  /** Count of footnote references [^N] */
  footnoteCount: number;
  /** Count of <R id="..."> resource components (optional) */
  rComponentCount?: number;
  /** Count of external links */
  externalLinks?: number;
  /** Rigor rating on 0–10 scale (from frontmatter/grading) */
  rigor: number | null;
  /** Quality score on 0–100 scale */
  quality: number | null;
  /** Whether the page has been human-reviewed */
  hasHumanReview?: boolean;
  /** Citation accuracy data from LLM verification */
  accuracy?: { checked: number; inaccurate: number } | null;
  /** Page body content (stripped of frontmatter) for integrity checks. Null to skip. */
  contentBody?: string | null;
  /** Content format (e.g. 'table', 'diagram') */
  contentFormat?: string | null;
}

/** Output from the canonical scorer */
export interface RiskResult {
  /** Risk level classification */
  level: 'low' | 'medium' | 'high';
  /** Numeric score 0–100 (higher = more risk) */
  score: number;
  /** Human-readable factor IDs explaining the score */
  factors: string[];
  /** Content integrity issues (if content body was provided) */
  integrityIssues?: string[];
}

// ---------------------------------------------------------------------------
// Entity type alias resolution
// ---------------------------------------------------------------------------

const ENTITY_TYPE_ALIASES: Record<string, string> = {
  researcher: 'person',
  lab: 'organization',
  'lab-frontier': 'organization',
  'lab-research': 'organization',
  'lab-academic': 'organization',
  'lab-startup': 'organization',
  'safety-approaches': 'safety-agenda',
  policies: 'policy',
  concepts: 'concept',
  events: 'event',
  models: 'model',
};

/** Resolve entity type aliases to canonical types */
export function resolveEntityType(rawType: string | null | undefined): string | null {
  if (!rawType) return null;
  return ENTITY_TYPE_ALIASES[rawType] || rawType;
}

// ---------------------------------------------------------------------------
// Accuracy risk (exported for direct use / testing)
// ---------------------------------------------------------------------------

/**
 * Compute accuracy-based risk contribution.
 *
 * Thresholds:
 *   >50% inaccurate → +20 points (majority-inaccurate)
 *   >30% inaccurate → +10 points (many-inaccurate)
 *   any inaccurate  → +5 points  (some-inaccurate)
 */
export function computeAccuracyRisk(
  checked: number,
  inaccurate: number,
): { score: number; factor: string | null } {
  if (
    !Number.isFinite(checked) || !Number.isFinite(inaccurate) ||
    checked <= 0 || inaccurate < 0
  ) {
    return { score: 0, factor: null };
  }
  const clampedInaccurate = Math.min(inaccurate, checked);
  const pct = clampedInaccurate / checked;
  if (pct > ACCURACY_MAJORITY_THRESHOLD) return { score: WEIGHT_ACCURACY_MAJORITY, factor: 'majority-inaccurate' };
  if (pct > ACCURACY_MANY_THRESHOLD) return { score: WEIGHT_ACCURACY_MANY, factor: 'many-inaccurate' };
  if (clampedInaccurate > 0) return { score: WEIGHT_ACCURACY_SOME, factor: 'some-inaccurate' };
  return { score: 0, factor: null };
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Compute hallucination risk score for a page.
 *
 * Returns { level, score, factors } with optional integrityIssues when
 * contentBody is provided.
 */
export function computeHallucinationRisk(input: RiskInput): RiskResult {
  let score = BASELINE_SCORE;
  const factors: string[] = [];
  const integrityIssues: string[] = [];

  const {
    entityType,
    wordCount,
    footnoteCount,
    rComponentCount = 0,
    externalLinks = 0,
    rigor,
    quality,
    hasHumanReview,
    accuracy,
    contentBody,
    contentFormat,
  } = input;

  const totalCitations = footnoteCount + rComponentCount;
  const citationDensity = wordCount > 0 ? (totalCitations / wordCount) * 1000 : 0;

  // === RISK-INCREASING FACTORS ===

  // Biographical pages: specific claims about real people/orgs
  if (entityType && BIOGRAPHICAL_TYPES.has(entityType)) {
    score += WEIGHT_BIOGRAPHICAL;
    factors.push('biographical-claims');
  }

  // Factual/historical pages: specific dates, events, numbers
  if (entityType && FACTUAL_TYPES.has(entityType)) {
    score += WEIGHT_FACTUAL;
    factors.push('specific-factual-claims');
  }

  // Citation density analysis
  if (totalCitations === 0 && wordCount > 300) {
    score += WEIGHT_NO_CITATIONS;
    factors.push('no-citations');
  } else if (citationDensity < CITATION_DENSITY_LOW && wordCount > 500) {
    score += WEIGHT_LOW_CITATION_DENSITY;
    factors.push('low-citation-density');
  }

  // Low rigor score (0–10 scale)
  if (rigor != null && rigor < 4) {
    score += WEIGHT_LOW_RIGOR;
    factors.push('low-rigor-score');
  }

  // Low quality score (0–100 scale)
  if (quality != null && quality < 40) {
    score += WEIGHT_LOW_QUALITY;
    factors.push('low-quality-score');
  }

  // Few external sources
  if (externalLinks < 2 && wordCount > 500) {
    score += WEIGHT_FEW_EXTERNAL;
    factors.push('few-external-sources');
  }

  // No human review
  if (hasHumanReview === false) {
    score += WEIGHT_NO_HUMAN_REVIEW;
    factors.push('no-human-review');
  }

  // Citation accuracy issues (from LLM verification)
  if (accuracy) {
    const accRisk = computeAccuracyRisk(accuracy.checked, accuracy.inaccurate);
    if (accRisk.factor) {
      score += accRisk.score;
      factors.push(accRisk.factor);
    }
  }

  // === RISK-DECREASING FACTORS ===

  // High citation density
  if (citationDensity > CITATION_DENSITY_HIGH) {
    score += WEIGHT_WELL_CITED; // negative weight
    factors.push('well-cited');
  } else if (citationDensity > CITATION_DENSITY_MODERATE) {
    score += WEIGHT_MODERATELY_CITED; // negative weight
    factors.push('moderately-cited');
  }

  // High rigor
  if (rigor != null && rigor >= 7) {
    score += WEIGHT_HIGH_RIGOR; // negative weight
    factors.push('high-rigor');
  }

  // Structural/conceptual content
  if (entityType && STRUCTURAL_TYPES.has(entityType)) {
    score += WEIGHT_STRUCTURAL; // negative weight
    factors.push('conceptual-content');
  }

  // Low-risk content formats
  if (contentFormat && LOW_RISK_FORMATS.has(contentFormat)) {
    score += WEIGHT_LOW_RISK_FORMAT; // negative weight
    factors.push('structured-format');
  }

  // Minimal content (stubs)
  if (wordCount < 300) {
    score += WEIGHT_MINIMAL_CONTENT; // negative weight
    factors.push('minimal-content');
  }

  // High quality
  if (quality != null && quality >= 80) {
    score += WEIGHT_HIGH_QUALITY; // negative weight
    factors.push('high-quality');
  }

  // Human-reviewed pages
  if (hasHumanReview === true) {
    score += WEIGHT_HUMAN_REVIEWED; // negative weight
    factors.push('human-reviewed');
  }

  // === CONTENT INTEGRITY SIGNALS ===
  if (contentBody) {
    const integrity = assessContentIntegrity(contentBody);
    const integrityRisk = computeIntegrityRisk(integrity);
    if (integrityRisk.score > 0) {
      score += integrityRisk.score;
      factors.push(...integrityRisk.factors);
      integrityIssues.push(...integrityRisk.factors);
    }
  }

  // Clamp to 0–100
  score = Math.max(0, Math.min(100, score));

  // Classify risk level
  const level: 'low' | 'medium' | 'high' =
    score <= THRESHOLD_LOW ? 'low' :
    score <= THRESHOLD_MEDIUM ? 'medium' :
    'high';

  const result: RiskResult = { level, score, factors };
  if (integrityIssues.length > 0) {
    result.integrityIssues = integrityIssues;
  }
  return result;
}
