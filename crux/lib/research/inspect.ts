/**
 * inspect.ts — local-only pre-flight inspection for improve-entity (QUA-1034).
 *
 * Loads an entity (already in memory or via findEntity), runs the gap
 * analyzer, and estimates per-entity cost from `pipeline_runs` history.
 * **Makes zero LLM calls**: pure file I/O + pure functions + one read-only
 * DB query for cost history. Used by `crux tb improve-entity --inspect` and
 * `crux tb improve-entity-suite --inspect` to surface what would be improved
 * (and approximately how much it would cost) without spending.
 *
 * Distinction from `--dry-run`: dry-run skips the YAML write at the end of
 * the loop but still runs the full LLM pipeline at full cost. `--inspect` is
 * a true cost-zero pre-flight — no Anthropic API calls, no research, no
 * proposeClaims — and is what users typically mean when they say "what would
 * this do".
 */

import {
  analyzePolicyGaps,
  analyzeOrganizationGaps,
  type Gap,
  type OrganizationEntity,
  type PolicyEntity,
} from './gap-analyzer.ts';
import { type EntityWithType } from './entity-loader.ts';
import {
  listPipelineRuns,
  type PipelineRunRow,
} from '../wiki-server/pipeline-runs.ts';
import { IMPROVE_ENTITY_PIPELINE_NAME } from '../improve-entity/mutex.ts';
import { formatCount } from '../output.ts';
import { median } from '../stats.ts';

/**
 * Per-entity fallback used when an entity has zero historical runs with a
 * populated `cost_usd`. Deliberately on the conservative-high side of the
 * spec's "$1-2 per policy entity" guidance — overestimating bumps the
 * displayed range, underestimating gets the user billed 2-3x what they
 * expected. Single constant for now; if calibration ever diverges by
 * entity type, switch to a `Record<string, number>`.
 */
const FALLBACK_COST_USD = 1.5;

/**
 * Spread on the displayed total cost range. The point estimate carries
 * appreciable variance — historical medians can drift run-to-run as the
 * pipeline's prompts and model selection change, and fallbacks are pure
 * guesses. ±50% gives users a bound that's honest about that uncertainty
 * without becoming useless (a 10x range would be "we have no idea").
 */
export const COST_RANGE_SPREAD = 0.5;

export interface InspectionReport {
  slug: string;
  /** stableId if present, else slug. */
  entityId: string;
  type: string;
  title: string;
  /** Counts of populated array/object fields, keyed by field name. */
  populated: Record<string, number>;
  gaps: Gap[];
  estimatedCostUsd: number;
  /** Source of the estimate: "history" (median of prior committed runs)
   *  or "fallback" (type-based hardcoded value). */
  costSource: 'history' | 'fallback';
  /** Count of historical runs that contributed (0 when source is fallback). */
  historicalRunCount: number;
}

/** Pure dispatch: gap analyzers + populated counts for supported types. */
export function inspectGaps(entity: EntityWithType): {
  gaps: Gap[];
  populated: Record<string, number>;
} {
  if (entity.type === 'policy') {
    const e = entity as PolicyEntity;
    return {
      gaps: analyzePolicyGaps(e),
      populated: {
        provisions: e.provisions?.length ?? 0,
        stakeholders: e.stakeholders?.length ?? 0,
        tags: e.tags?.length ?? 0,
        relatedEntries: e.relatedEntries?.length ?? 0,
      },
    };
  }
  if (entity.type === 'organization') {
    const e = entity as OrganizationEntity;
    return {
      gaps: analyzeOrganizationGaps(e),
      populated: {
        products: e.products?.length ?? 0,
        keyPeople: e.keyPeople?.length ?? 0,
        keyDates: e.keyDates?.length ?? 0,
        tags: e.tags?.length ?? 0,
        relatedEntries: e.relatedEntries?.length ?? 0,
      },
    };
  }
  return { gaps: [], populated: {} };
}

/**
 * Estimate per-entity cost from historical pipeline_runs. Pure given the
 * `runs` argument. Filters to committed runs for THIS entity with a
 * non-null, positive `cost_usd`; if any match, returns the median (more
 * robust to outliers than mean). Otherwise falls back to the type-based
 * hardcoded estimate.
 *
 * Why `committed` only: aborted/oscillation runs may have only partial
 * spend before they bailed; including them would systematically underestimate.
 */
export function estimateEntityCost(
  entity: EntityWithType,
  runs: PipelineRunRow[],
): { estimatedCostUsd: number; costSource: 'history' | 'fallback'; historicalRunCount: number } {
  const targetId = entity.stableId ?? entity.id;
  const matched: number[] = [];
  for (const r of runs) {
    if (r.entityId !== targetId) continue;
    if (r.status !== 'committed') continue;
    if (r.costUsd == null) continue;
    // Drizzle returns numeric() columns as strings — coerce explicitly.
    const c = typeof r.costUsd === 'number' ? r.costUsd : Number(r.costUsd);
    if (!Number.isFinite(c) || c <= 0) continue;
    matched.push(c);
  }
  if (matched.length > 0) {
    return {
      estimatedCostUsd: median(matched),
      costSource: 'history',
      historicalRunCount: matched.length,
    };
  }
  return { estimatedCostUsd: FALLBACK_COST_USD, costSource: 'fallback', historicalRunCount: 0 };
}

/**
 * Build a full inspection report for a single entity. Pure given the
 * `runs` argument. Caller passes in the relevant `improve-entity` rows
 * (or an empty array to force fallback estimation in offline mode / tests).
 */
export function buildInspectionReport(
  entity: EntityWithType,
  runs: PipelineRunRow[],
): InspectionReport {
  const { gaps, populated } = inspectGaps(entity);
  const cost = estimateEntityCost(entity, runs);
  const titleRaw = entity.title;
  return {
    slug: entity.id,
    entityId: entity.stableId ?? entity.id,
    type: entity.type,
    title: typeof titleRaw === 'string' ? titleRaw : entity.id,
    populated,
    gaps,
    ...cost,
  };
}

/** Format the populated-counts object as a human-readable phrase. */
function formatPopulated(populated: Record<string, number>): string {
  const parts = Object.entries(populated)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length > 0 ? parts.join(', ') : 'empty';
}

/** Format a single inspection report as a human-readable line. */
export function formatInspectionLine(r: InspectionReport): string {
  const populatedSummary = formatPopulated(r.populated);
  const gapKeys = r.gaps.map((g) => g.key).join(', ');
  const gapsSummary = gapKeys || 'none';
  const costSrc =
    r.costSource === 'history'
      ? `est from ${formatCount(r.historicalRunCount, 'prior run')}`
      : 'fallback est';
  return `- ${r.slug} (${r.entityId}): ${populatedSummary}. Gaps: ${gapsSummary}. Est: $${r.estimatedCostUsd.toFixed(2)} (${costSrc}).`;
}

/** Format the suite-level header line (entity count + estimated total range). */
export function formatInspectionHeader(
  reports: InspectionReport[],
  suiteName = 'Suite',
): string {
  const total = reports.reduce((s, r) => s + r.estimatedCostUsd, 0);
  const lo = (total * (1 - COST_RANGE_SPREAD)).toFixed(2);
  const hi = (total * (1 + COST_RANGE_SPREAD)).toFixed(2);
  return `${suiteName}: ${formatCount(reports.length, 'entity', 'entities')}, estimated total cost: $${lo}–$${hi} (point: $${total.toFixed(2)})`;
}

/** Format a full suite report (header + per-entity lines). */
export function formatInspectionSuite(
  reports: InspectionReport[],
  suiteName = 'Suite',
): string {
  return [formatInspectionHeader(reports, suiteName), ...reports.map(formatInspectionLine)].join('\n');
}

/**
 * Fetch recent improve-entity runs for cost estimation. Returns an empty
 * array (with a warning log) if the wiki-server is unreachable — `--inspect`
 * is meant to be best-effort and degrades to fallback estimates rather than
 * failing. Limit defaults to 500 (the route's hard cap) which keeps a
 * generous history window without paginating.
 */
export async function fetchHistoricalRuns(
  limit: number = 500,
): Promise<PipelineRunRow[]> {
  const r = await listPipelineRuns({
    pipelineName: IMPROVE_ENTITY_PIPELINE_NAME,
    limit,
  });
  if (!r.ok) {
    // ApiResult error union has both `error` (machine code, always present) and
    // `message` (human-readable). Log both — the previous form `?? r.message ??
    // 'unknown'` was dead because `error` is never null.
    console.warn(
      `[inspect] failed to fetch pipeline_runs history (${r.error}: ${r.message}); ` +
        `using fallback cost estimates`,
    );
    return [];
  }
  return r.data.runs;
}
