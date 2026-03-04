/**
 * Coverage Targets & Gap Analysis
 *
 * Defines how many statements each entity type "should" have per property
 * category, and computes a coverage score + prioritized gap list.
 *
 * No DB changes — pure TypeScript constants + formula functions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Target statement counts per property category. */
export type CoverageTargets = Record<string, number>;

/** A single category gap with priority ranking. */
export interface CategoryGap {
  category: string;
  target: number;
  actual: number;
  fillRate: number;
  deficit: number;
  /** Priority = (1 - fillRate) × categoryImportance. Higher = more urgent. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Category importance weights (reused from scoring.ts for consistency)
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

const DEFAULT_IMPORTANCE = 0.50;

// ---------------------------------------------------------------------------
// Coverage target definitions
// ---------------------------------------------------------------------------

/**
 * Coverage targets keyed by `"entityType:orgType"` with fallback to `"entityType"`.
 * Values are target statement counts per category.
 */
const TARGETS: Record<string, CoverageTargets> = {
  'organization:frontier-lab': {
    financial: 12,
    safety: 10,
    technical: 10,
    organizational: 8,
    research: 8,
    relation: 6,
    milestone: 5,
  },
  'organization:safety-org': {
    safety: 12,
    research: 10,
    organizational: 8,
    financial: 6,
    relation: 5,
    milestone: 4,
  },
  organization: {
    financial: 6,
    safety: 6,
    technical: 6,
    organizational: 6,
    research: 6,
    relation: 6,
    milestone: 6,
  },
  person: {
    research: 8,
    organizational: 6,
    relation: 5,
    safety: 5,
    milestone: 4,
  },
  model: {
    technical: 12,
    safety: 8,
    research: 6,
    milestone: 4,
    financial: 3,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the coverage targets for a given entity type + optional org type.
 * Tries `"entityType:orgType"` first, then bare `"entityType"`.
 * Returns null if no targets are defined for this entity type.
 */
export function resolveCoverageTargets(
  entityType: string,
  orgType?: string | null,
): CoverageTargets | null {
  if (orgType) {
    const specific = TARGETS[`${entityType}:${orgType}`];
    if (specific) return specific;
  }
  return TARGETS[entityType] ?? null;
}

/**
 * Compute a weighted coverage score from actual statement counts vs targets.
 *
 * Formula: Σ(min(1, actual/target) × importance) / Σ(importance)
 *
 * Returns a value between 0.0 and 1.0.
 */
export function computeCoverageScore(
  actualCounts: Record<string, number>,
  targets: CoverageTargets,
): number {
  let weightedSum = 0;
  let weightTotal = 0;

  for (const [category, target] of Object.entries(targets)) {
    const actual = actualCounts[category] ?? 0;
    const fillRate = Math.min(1, actual / target);
    const importance = CATEGORY_IMPORTANCE[category] ?? DEFAULT_IMPORTANCE;
    weightedSum += fillRate * importance;
    weightTotal += importance;
  }

  if (weightTotal === 0) return 0;
  return Math.round((weightedSum / weightTotal) * 1000) / 1000;
}

/**
 * Compute per-category gaps sorted by priority (highest first).
 *
 * Priority = (1 - fillRate) × categoryImportance
 * Categories at or above target are included with priority 0.
 */
export function computeGaps(
  actualCounts: Record<string, number>,
  targets: CoverageTargets,
): CategoryGap[] {
  const gaps: CategoryGap[] = [];

  for (const [category, target] of Object.entries(targets)) {
    const actual = actualCounts[category] ?? 0;
    const fillRate = Math.min(1, actual / target);
    const importance = CATEGORY_IMPORTANCE[category] ?? DEFAULT_IMPORTANCE;
    const priority = Math.round((1 - fillRate) * importance * 1000) / 1000;

    gaps.push({
      category,
      target,
      actual,
      fillRate: Math.round(fillRate * 1000) / 1000,
      deficit: Math.max(0, target - actual),
      priority,
    });
  }

  return gaps.sort((a, b) => b.priority - a.priority);
}
