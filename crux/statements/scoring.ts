/**
 * Statement Quality Scoring — 10-dimension quality scoring for statements.
 *
 * Each dimension returns a score from 0.0 to 1.0. The composite score is a
 * weighted average of intrinsic (structure/precision/clarity/resolvability/
 * uniqueness/atomicity) and extrinsic (importance/neglectedness/recency/
 * crossEntityUtility) dimensions.
 *
 * 8 dimensions are fully automated; 2 (importance, clarity) use lightweight
 * heuristics as placeholders for future LLM scoring.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jaccardWordSimilarity } from '../lib/claim-utils.ts';
import { containsEntityReference, slugToDisplayName } from '../lib/claim-text-utils.ts';
import { VAGUE_PATTERNS } from '../claims/validate-quality/types.ts';
import { callLlm, MODELS } from '../lib/llm.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import type { CostTracker } from '../lib/cost-tracker.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A statement row with optional joined data needed for scoring. */
export interface ScoringStatement {
  id: number;
  variety: string;
  statementText: string | null;
  subjectEntityId: string;
  propertyId: string | null;
  valueNumeric: number | null;
  valueUnit: string | null;
  valueText: string | null;
  valueEntityId: string | null;
  valueDate: string | null;
  validStart: string | null;
  validEnd: string | null;
  status: string;
  claimCategory: string | null;
  citations?: Array<{
    resourceId: string | null;
    url: string | null;
    sourceQuote: string | null;
  }>;
  property?: {
    id: string;
    label: string;
    category: string;
    stalenessCadence?: string | null;
  } | null;
}

/** Per-dimension score object stored in quality_dimensions JSONB. */
export interface QualityDimensions {
  structure: number;
  precision: number;
  clarity: number;
  resolvability: number;
  uniqueness: number;
  atomicity: number;
  importance: number;
  neglectedness: number;
  recency: number;
  crossEntityUtility: number;
}

/** Canonical list of dimension names, type-constrained to match QualityDimensions keys. */
export const DIMENSION_NAMES = [
  'structure', 'precision', 'clarity', 'resolvability',
  'uniqueness', 'atomicity', 'importance', 'neglectedness',
  'recency', 'crossEntityUtility',
] as const satisfies readonly (keyof QualityDimensions)[];

/** Result of scoring a single statement. */
export interface ScoringResult {
  statementId: number;
  qualityScore: number;
  dimensions: QualityDimensions;
}

/** Context needed for relative scoring dimensions (uniqueness, neglectedness). */
export interface ScoringContext {
  /** All sibling statements for the same entity. */
  siblings: ScoringStatement[];
  /** Entity ID for self-containedness check. */
  entityId: string;
  /** Display name for clarity check. */
  entityName: string;
  /** Current date for recency calculations. */
  now?: Date;
}

/** Context for opt-in LLM-based scoring of importance + clarity. */
export interface LlmScoringContext {
  client: Anthropic;
  entityName: string;
  entityType: string;
  tracker?: CostTracker;
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const INTRINSIC_WEIGHTS = {
  structure: 0.20,
  precision: 0.15,
  clarity: 0.15,
  resolvability: 0.25,
  uniqueness: 0.15,
  atomicity: 0.10,
} as const;

const EXTRINSIC_WEIGHTS = {
  importance: 0.40,
  neglectedness: 0.30,
  recency: 0.15,
  crossEntityUtility: 0.15,
} as const;

const INTRINSIC_EXTRINSIC_SPLIT = 0.50;

// ---------------------------------------------------------------------------
// Category importance weights (heuristic for the importance dimension)
// ---------------------------------------------------------------------------

const CATEGORY_IMPORTANCE: Record<string, number> = {
  safety: 0.95,
  financial: 0.85,
  technical: 0.80,
  research: 0.80,
  organizational: 0.70,
  milestone: 0.65,
  relation: 0.60,
};

const DEFAULT_CATEGORY_IMPORTANCE = 0.50;

// ---------------------------------------------------------------------------
// Staleness cadence → days mapping for recency scoring
// ---------------------------------------------------------------------------

const CADENCE_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  annually: 365,
  biannually: 730,
};

// ---------------------------------------------------------------------------
// Individual scoring dimensions
// ---------------------------------------------------------------------------

/**
 * Structure: Does the statement have structured property+value+unit data?
 * 1.0 = property + value + unit, 0.75 = property + value, 0.5 = property only, 0.0 = text-only
 */
export function scoreStructure(stmt: ScoringStatement): number {
  if (!stmt.propertyId) return 0.0;

  const hasValue = stmt.valueNumeric != null ||
    (stmt.valueText != null && stmt.valueText.length > 0) ||
    stmt.valueEntityId != null ||
    stmt.valueDate != null;

  const hasUnit = stmt.valueUnit != null && stmt.valueUnit.length > 0;

  if (hasValue && hasUnit) return 1.0;
  if (hasValue) return 0.75;
  return 0.5;
}

/**
 * Precision: Does the statement use specific, measurable language?
 * Penalizes vague words (significant, various, several, etc.) when no specifics present.
 * Rewards numeric values, dates, and entity references.
 */
export function scorePrecision(stmt: ScoringStatement): number {
  const text = stmt.statementText ?? '';
  if (text.length === 0) return 0.0;

  let score = 0.5; // baseline

  // Boost for numeric specifics
  if (/\d/.test(text)) score += 0.2;
  if (stmt.valueNumeric != null) score += 0.15;

  // Boost for date specifics
  if (stmt.validStart || /\b(?:19|20)\d{2}\b/.test(text)) score += 0.1;

  // Boost for entity references in value
  if (stmt.valueEntityId) score += 0.05;

  // Penalize vague language
  const hasSpecifics = /\d/.test(text);
  if (!hasSpecifics) {
    for (const { pattern } of VAGUE_PATTERNS) {
      if (pattern.test(text)) {
        score -= 0.25;
        break;
      }
    }
  }

  return Math.max(0.0, Math.min(1.0, score));
}

/**
 * Clarity: Is the statement self-contained and complete?
 * Checks for entity name reference, terminal punctuation, and adequate length.
 */
export function scoreClarity(stmt: ScoringStatement, entityId: string, entityName: string): number {
  const text = stmt.statementText ?? '';
  if (text.length === 0) return 0.0;

  let score = 0.0;

  // Entity name present (self-contained)
  if (containsEntityReference(text, entityId, entityName)) {
    score += 0.4;
  }

  // Terminal punctuation
  if (/[.!?]$/.test(text.trim())) {
    score += 0.2;
  }

  // Adequate length (40+ chars is a well-formed sentence)
  if (text.length >= 40) {
    score += 0.3;
  } else if (text.length >= 20) {
    score += 0.15;
  }

  // Not too long (overly verbose reduces clarity)
  if (text.length <= 300) {
    score += 0.1;
  }

  return Math.min(1.0, score);
}

/**
 * Resolvability: Can the statement be traced to a source?
 * 1.0 = citation + sourceQuote + URL, 0.66 = citation + URL, 0.33 = citation only, 0.0 = none
 */
export function scoreResolvability(stmt: ScoringStatement): number {
  const citations = stmt.citations ?? [];
  if (citations.length === 0) return 0.0;

  // Score based on the best citation
  let bestScore = 0.0;
  for (const cit of citations) {
    let citScore = 0.33; // has a citation
    if (cit.url || cit.resourceId) citScore = 0.66;
    if ((cit.url || cit.resourceId) && cit.sourceQuote) citScore = 1.0;
    bestScore = Math.max(bestScore, citScore);
  }

  return bestScore;
}

/**
 * Uniqueness: Is this statement distinct from its siblings?
 * 1.0 - max Jaccard similarity to any sibling statement.
 */
export function scoreUniqueness(stmt: ScoringStatement, siblings: ScoringStatement[]): number {
  const text = stmt.statementText ?? '';
  if (text.length === 0) return 0.0;

  let maxSimilarity = 0.0;
  for (const sibling of siblings) {
    if (sibling.id === stmt.id) continue;
    const sibText = sibling.statementText ?? '';
    if (sibText.length === 0) continue;
    const sim = jaccardWordSimilarity(text, sibText);
    maxSimilarity = Math.max(maxSimilarity, sim);
  }

  return Math.max(0.0, 1.0 - maxSimilarity);
}

/**
 * Atomicity: Does the statement express a single fact?
 * Adapted from checkAtomic() — penalizes semicolons, compound conjunctions, connective adverbs.
 */
export function scoreAtomicity(stmt: ScoringStatement): number {
  const text = stmt.statementText ?? '';
  if (text.length === 0) return 0.0;

  // Semicolons splitting independent clauses
  if (/;\s+[A-Z]/.test(text)) return 0.0;

  // Comma + "and" + uppercase (two distinct facts)
  if (/,\s+and\s+(?:also\s+)?[A-Z]/.test(text)) return 0.0;

  // Connective adverbs joining sentences
  if (/\.\s+(?:Additionally|Also|Furthermore|Moreover),?\s+/i.test(text)) return 0.0;

  // Multiple sentences (more than one period followed by a capital letter)
  const sentenceBreaks = (text.match(/\.\s+[A-Z]/g) ?? []).length;
  if (sentenceBreaks >= 2) return 0.25;
  if (sentenceBreaks === 1) return 0.5;

  return 1.0;
}

/**
 * Recency: How fresh is the statement's data?
 * Based on validStart vs current date, weighted by property's stalenessCadence.
 * Evergreen facts (no cadence) get 1.0.
 */
export function scoreRecency(stmt: ScoringStatement, now?: Date): number {
  const cadence = stmt.property?.stalenessCadence;

  // No staleness cadence — evergreen fact
  if (!cadence) return 1.0;

  const cadenceDays = CADENCE_DAYS[cadence];
  if (!cadenceDays) return 1.0; // unknown cadence, treat as evergreen

  // No temporal anchor — can't assess freshness
  if (!stmt.validStart) return 0.3;

  const currentDate = now ?? new Date();
  const startDate = parsePartialDate(stmt.validStart);
  if (!startDate) return 0.3;

  const daysSince = (currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);

  // Score based on how many cadence periods have passed
  // 0 periods = 1.0, 1 period = 0.7, 2 periods = 0.4, 3+ = 0.1
  const periodsElapsed = daysSince / cadenceDays;
  if (periodsElapsed <= 0.5) return 1.0;
  if (periodsElapsed <= 1.0) return 0.85;
  if (periodsElapsed <= 2.0) return 0.6;
  if (periodsElapsed <= 3.0) return 0.35;
  return 0.1;
}

/**
 * Neglectedness: Is this statement in an underrepresented category for its entity?
 * Inverse density: if entity has many financial stmts and few safety, safety scores higher.
 */
export function scoreNeglectedness(stmt: ScoringStatement, siblings: ScoringStatement[]): number {
  const category = stmt.property?.category;
  if (!category) return 0.5; // no category — neutral

  // Count statements per category among siblings
  const categoryCounts = new Map<string, number>();
  for (const sib of siblings) {
    const cat = sib.property?.category;
    if (cat) {
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
  }

  const totalCategorized = Array.from(categoryCounts.values()).reduce((a, b) => a + b, 0);
  if (totalCategorized === 0) return 0.5;

  const thisCount = categoryCounts.get(category) ?? 0;
  const numCategories = categoryCounts.size;

  // Expected proportion if evenly distributed
  const expectedProportion = 1 / numCategories;
  const actualProportion = thisCount / totalCategorized;

  // If underrepresented, score higher
  if (actualProportion <= expectedProportion * 0.5) return 1.0;
  if (actualProportion <= expectedProportion) return 0.8;
  if (actualProportion <= expectedProportion * 2) return 0.5;
  return 0.3;
}

/**
 * Cross-entity utility: Does this statement connect to other entities?
 * 1.0 = valueEntityId set (relational), 0.5 = text mentions entity slugs, 0.0 = self-contained
 */
export function scoreCrossEntityUtility(stmt: ScoringStatement): number {
  if (stmt.valueEntityId) return 1.0;

  const text = stmt.statementText ?? '';
  // Check for mentions of other entity patterns (e.g., slug-like words with hyphens)
  // Simple heuristic: property category is 'relation'
  if (stmt.property?.category === 'relation') return 0.8;

  // Check for entity-like references in text (e.g., "OpenAI", "Google DeepMind", "GPT-4")
  // Matches: multi-word Title Case ("Google DeepMind"), single capitalized words that look
  // like org names ("OpenAI"), and acronyms with optional suffixes ("GPT-4", "RLHF")
  const namedEntityPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b|\b[A-Z][a-z]*[A-Z]\w*\b|\b[A-Z]{2,}(?:-\w+)?\b/g;
  const matches = text.match(namedEntityPattern) ?? [];
  // Filter out the subject entity name and common false positives
  const entityName = slugToDisplayName(stmt.subjectEntityId);
  const falsePositives = new Set(['The', 'This', 'That', 'These', 'Those', 'It', 'In', 'On', 'At', 'By', 'For', 'USD', 'CEO', 'CTO', 'CFO', 'COO']);
  const otherEntities = matches.filter(m => m !== entityName && !falsePositives.has(m));

  if (otherEntities.length > 0) return 0.5;
  return 0.0;
}

/**
 * Importance: How important is this property category for the entity type?
 * Heuristic based on category importance weights. Future: LLM-assessed.
 */
export function scoreImportance(stmt: ScoringStatement): number {
  const category = stmt.property?.category;
  if (!category) return DEFAULT_CATEGORY_IMPORTANCE;
  return CATEGORY_IMPORTANCE[category] ?? DEFAULT_CATEGORY_IMPORTANCE;
}

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

/** Compute the weighted composite score from a dimensions object. */
export function computeComposite(dimensions: QualityDimensions): number {
  const intrinsic =
    INTRINSIC_WEIGHTS.structure * dimensions.structure +
    INTRINSIC_WEIGHTS.precision * dimensions.precision +
    INTRINSIC_WEIGHTS.clarity * dimensions.clarity +
    INTRINSIC_WEIGHTS.resolvability * dimensions.resolvability +
    INTRINSIC_WEIGHTS.uniqueness * dimensions.uniqueness +
    INTRINSIC_WEIGHTS.atomicity * dimensions.atomicity;

  const extrinsic =
    EXTRINSIC_WEIGHTS.importance * dimensions.importance +
    EXTRINSIC_WEIGHTS.neglectedness * dimensions.neglectedness +
    EXTRINSIC_WEIGHTS.recency * dimensions.recency +
    EXTRINSIC_WEIGHTS.crossEntityUtility * dimensions.crossEntityUtility;

  return Math.round(
    (INTRINSIC_EXTRINSIC_SPLIT * intrinsic + (1 - INTRINSIC_EXTRINSIC_SPLIT) * extrinsic) * 1000,
  ) / 1000;
}

/** Score a single statement across all 10 dimensions and compute composite. */
export function scoreStatement(stmt: ScoringStatement, ctx: ScoringContext): ScoringResult {
  const dimensions: QualityDimensions = {
    structure: scoreStructure(stmt),
    precision: scorePrecision(stmt),
    clarity: scoreClarity(stmt, ctx.entityId, ctx.entityName),
    resolvability: scoreResolvability(stmt),
    uniqueness: scoreUniqueness(stmt, ctx.siblings),
    atomicity: scoreAtomicity(stmt),
    importance: scoreImportance(stmt),
    neglectedness: scoreNeglectedness(stmt, ctx.siblings),
    recency: scoreRecency(stmt, ctx.now),
    crossEntityUtility: scoreCrossEntityUtility(stmt),
  };

  return {
    statementId: stmt.id,
    qualityScore: computeComposite(dimensions),
    dimensions,
  };
}

/** Score all statements for an entity. */
export function scoreAllStatements(
  stmts: ScoringStatement[],
  entityId: string,
  entityName: string,
  now?: Date,
): ScoringResult[] {
  const ctx: ScoringContext = {
    siblings: stmts,
    entityId,
    entityName,
    now,
  };

  return stmts.map((stmt) => scoreStatement(stmt, ctx));
}

// ---------------------------------------------------------------------------
// LLM-based scoring (opt-in, behind --llm flag)
// ---------------------------------------------------------------------------

const LLM_CONCURRENCY = 5;

/** LLM-based importance scoring. Falls back to heuristic on error. */
export async function scoreImportanceLlm(
  stmt: ScoringStatement,
  llmCtx: LlmScoringContext,
): Promise<number> {
  const text = stmt.statementText ?? '';
  if (text.length === 0) return DEFAULT_CATEGORY_IMPORTANCE;

  try {
    const result = await callLlm(llmCtx.client, {
      system: 'You are an AI safety research analyst scoring statement importance. Respond ONLY with a JSON object.',
      user: `Rate the importance of this statement about ${llmCtx.entityName} (${llmCtx.entityType}) on a scale from 0.0 to 1.0, where 1.0 is critically important for understanding the entity and 0.0 is trivial.

Statement: "${text}"
Category: ${stmt.property?.category ?? 'unknown'}

Respond with: {"score": <number>, "reason": "<brief reason>"}`,
    }, {
      model: MODELS.haiku,
      maxTokens: 200,
      temperature: 0,
      retryLabel: 'importance-llm',
      tracker: llmCtx.tracker,
      label: 'importance',
    });

    const parsed = parseJsonFromLlm<{ score?: number }>(
      result.text,
      'importance-llm',
      () => ({ score: undefined }),
    );

    if (typeof parsed.score === 'number' && parsed.score >= 0 && parsed.score <= 1) {
      return Math.round(parsed.score * 1000) / 1000;
    }
  } catch (e: unknown) {
    // Intentional fallback: LLM failure → heuristic score
    console.warn(`[scoring] LLM importance scoring failed, using heuristic: ${e instanceof Error ? e.message : String(e)}`);
  }

  return scoreImportance(stmt);
}

/** LLM-based clarity scoring. Falls back to heuristic on error. */
export async function scoreClarityLlm(
  stmt: ScoringStatement,
  entityId: string,
  entityName: string,
  llmCtx: LlmScoringContext,
): Promise<number> {
  const text = stmt.statementText ?? '';
  if (text.length === 0) return 0.0;

  try {
    const result = await callLlm(llmCtx.client, {
      system: 'You are a technical writing analyst scoring statement clarity. Respond ONLY with a JSON object.',
      user: `Rate the clarity of this statement about ${entityName} on a scale from 0.0 to 1.0, where 1.0 is perfectly clear and self-contained and 0.0 is incomprehensible without context.

Consider:
- Is the subject (entity name) mentioned or clearly implied?
- Is the statement grammatically complete?
- Would a reader understand this without additional context?

Statement: "${text}"

Respond with: {"score": <number>, "reason": "<brief reason>"}`,
    }, {
      model: MODELS.haiku,
      maxTokens: 200,
      temperature: 0,
      retryLabel: 'clarity-llm',
      tracker: llmCtx.tracker,
      label: 'clarity',
    });

    const parsed = parseJsonFromLlm<{ score?: number }>(
      result.text,
      'clarity-llm',
      () => ({ score: undefined }),
    );

    if (typeof parsed.score === 'number' && parsed.score >= 0 && parsed.score <= 1) {
      return Math.round(parsed.score * 1000) / 1000;
    }
  } catch (e: unknown) {
    // Intentional fallback: LLM failure → heuristic score
    console.warn(`[scoring] LLM clarity scoring failed, using heuristic: ${e instanceof Error ? e.message : String(e)}`);
  }

  return scoreClarity(stmt, entityId, entityName);
}

/** Score a single statement with optional LLM-based dimensions. */
export async function scoreStatementAsync(
  stmt: ScoringStatement,
  ctx: ScoringContext,
  llmCtx?: LlmScoringContext,
): Promise<ScoringResult> {
  const [importance, clarity] = llmCtx
    ? await Promise.all([
        scoreImportanceLlm(stmt, llmCtx),
        scoreClarityLlm(stmt, ctx.entityId, ctx.entityName, llmCtx),
      ])
    : [scoreImportance(stmt), scoreClarity(stmt, ctx.entityId, ctx.entityName)];

  const dimensions: QualityDimensions = {
    structure: scoreStructure(stmt),
    precision: scorePrecision(stmt),
    clarity,
    resolvability: scoreResolvability(stmt),
    uniqueness: scoreUniqueness(stmt, ctx.siblings),
    atomicity: scoreAtomicity(stmt),
    importance,
    neglectedness: scoreNeglectedness(stmt, ctx.siblings),
    recency: scoreRecency(stmt, ctx.now),
    crossEntityUtility: scoreCrossEntityUtility(stmt),
  };

  return {
    statementId: stmt.id,
    qualityScore: computeComposite(dimensions),
    dimensions,
  };
}

/**
 * Score all statements with optional LLM-based dimensions.
 * Uses concurrency-limited parallelism for LLM calls.
 */
export async function scoreAllStatementsAsync(
  stmts: ScoringStatement[],
  entityId: string,
  entityName: string,
  now?: Date,
  llmCtx?: LlmScoringContext,
): Promise<ScoringResult[]> {
  const ctx: ScoringContext = {
    siblings: stmts,
    entityId,
    entityName,
    now,
  };

  if (!llmCtx) {
    return stmts.map((stmt) => scoreStatement(stmt, ctx));
  }

  // Process in batches for concurrency control
  const results: ScoringResult[] = [];
  for (let i = 0; i < stmts.length; i += LLM_CONCURRENCY) {
    const batch = stmts.slice(i, i + LLM_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((stmt) => scoreStatementAsync(stmt, ctx, llmCtx)),
    );
    results.push(...batchResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse partial date strings like "2025", "2025-07", "2025-07-15". */
function parsePartialDate(dateStr: string): Date | null {
  // Full ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
  // Year-month
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    const d = new Date(dateStr + '-01');
    return isNaN(d.getTime()) ? null : d;
  }
  // Year only
  if (/^\d{4}$/.test(dateStr)) {
    const d = new Date(dateStr + '-07-01'); // mid-year estimate
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
