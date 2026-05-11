/**
 * Shared verdict display infrastructure.
 *
 * Two distinct verdict domains exist in the codebase:
 *
 * 1. **Source-check verdicts** — entity/FactBase sourcing results.
 *    Keys: confirmed, contradicted, outdated, partial, unverifiable, unchecked.
 *    Used by: entity-detail-components, SourcingStatus, sourcing pages,
 *    entity-sourcing dashboards.
 *
 * 2. **Citation verdicts** — wiki page citation accuracy checks.
 *    Keys: accurate, minor_issues, inaccurate, unsupported, not_verifiable.
 *    Used by: VerdictBadge (wiki), resource-utils, ReferenceCitationDetails.
 *
 * This module provides canonical style definitions for both domains so that
 * consuming components don't need to redeclare colors and labels locally.
 */

// ── Source-check verdict types ──────────────────────────────────────────

export type SourcingVerdictType =
  | "confirmed"
  | "contradicted"
  | "outdated"
  | "partial"
  | "unverifiable"
  | "unchecked";

/**
 * Full style set for sourcing verdicts, covering all shape variants
 * used across the codebase:
 * - `label` + `className`: entity-detail-components badge
 * - `bg` + `text` + `dot`: SourcingStatus, sourcing-shared, action-queue
 */
export interface SourcingVerdictStyle {
  /** Human-readable label (e.g. "Confirmed") */
  label: string;
  /** Combined Tailwind className for the entity-detail badge variant */
  className: string;
  /** Background class (e.g. "bg-emerald-500/15") */
  bg: string;
  /** Text color class (e.g. "text-emerald-600") */
  text: string;
  /** Dot color class used by SourcingStatus (e.g. "bg-emerald-500") */
  dot: string;
}

export const SOURCE_CHECK_VERDICT_STYLES: Record<SourcingVerdictType, SourcingVerdictStyle> = {
  confirmed: {
    label: "Confirmed",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    bg: "bg-emerald-500/15",
    text: "text-emerald-600",
    dot: "bg-emerald-500",
  },
  contradicted: {
    label: "Contradicted",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    bg: "bg-red-500/15",
    text: "text-red-600",
    dot: "bg-red-500",
  },
  outdated: {
    label: "Outdated",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    bg: "bg-amber-500/15",
    text: "text-amber-600",
    dot: "bg-amber-500",
  },
  partial: {
    label: "Partial",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    bg: "bg-amber-400/15",
    text: "text-amber-500",
    dot: "bg-amber-400",
  },
  unverifiable: {
    label: "Unverifiable",
    className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    bg: "bg-red-400/15",
    text: "text-red-600",
    dot: "bg-red-400",
  },
  unchecked: {
    label: "Unchecked",
    className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    bg: "bg-gray-400/15",
    text: "text-gray-400",
    dot: "bg-gray-300",
  },
};

/** Tooltip descriptions for sourcing verdict types. */
export const SOURCE_CHECK_VERDICT_DESCRIPTIONS: Record<SourcingVerdictType, string> = {
  confirmed: "Source evidence supports this claim.",
  contradicted: "Source evidence contradicts this claim.",
  outdated: "Source evidence suggests this information is no longer current.",
  partial: "Source evidence partially supports this claim, but some details differ.",
  unverifiable: "Unable to verify this claim from available sources.",
  unchecked: "This claim has not yet been checked against sources.",
};

/**
 * Sort priority for sourcing verdicts: most actionable first. Lower = higher priority.
 *
 * Note: visual severity (red/amber/green) and actionability priority are *intentionally*
 * different axes. `unverifiable` renders red (same severity bucket as `contradicted`) but
 * is ranked less actionable than `partial`/`outdated` here, because "no support found"
 * gives an editor less to work with than "some support found, but stale" (`outdated`) or
 * "some support found, but only partial" (`partial`). Don't "fix" this by reordering to
 * match the visual severity — entity-sourcing aggregation depends on this ordering
 * (see `entity-sourcing.test.ts` and the QUA-429 contract in `tablebase.ts`).
 */
export const SOURCE_CHECK_VERDICT_PRIORITY: Record<string, number> = {
  contradicted: 0,
  outdated: 1,
  partial: 2,
  unverifiable: 3,
  confirmed: 4,
  unchecked: 5,
};

// ── Citation verdict types ──────────────────────────────────────────────

/** Canonical citation verdict keys used by the citation sourcing system. */
export const CITATION_VERDICT_KEYS = [
  "accurate",
  "minor_issues",
  "inaccurate",
  "unsupported",
  "not_verifiable",
] as const;

export type CitationVerdictKey = (typeof CITATION_VERDICT_KEYS)[number];

/** Rich citation verdict styles used by ReferenceCitationDetails claim rows. */
export const CITATION_VERDICT_STYLES: Record<
  string,
  { color: string; bg: string; label: string }
> = {
  accurate: { color: "text-emerald-700", bg: "bg-emerald-500/10", label: "Accurate" },
  minor_issues: { color: "text-amber-700", bg: "bg-amber-500/10", label: "Minor issues" },
  inaccurate: { color: "text-red-700", bg: "bg-red-500/10", label: "Inaccurate" },
  unsupported: { color: "text-red-600", bg: "bg-red-500/10", label: "Unsupported" },
  not_verifiable: { color: "text-muted-foreground", bg: "bg-muted", label: "Not verifiable" },
};

/** Compact dot colors used by ReferenceCitationDot. */
export const CITATION_VERDICT_COLORS: Record<string, { bg: string; title: string }> = {
  accurate: { bg: "bg-emerald-500", title: "Verified accurate" },
  minor_issues: { bg: "bg-amber-500", title: "Minor issues" },
  inaccurate: { bg: "bg-red-500", title: "Inaccurate" },
  unsupported: { bg: "bg-red-400", title: "Unsupported" },
  not_verifiable: { bg: "bg-muted-foreground/40", title: "Not verifiable" },
};

/** Severity ordering for citation verdicts (lower = more severe). */
export const CITATION_VERDICT_SEVERITY: Record<string, number> = {
  inaccurate: 0,
  unsupported: 1,
  minor_issues: 2,
  not_verifiable: 3,
  accurate: 4,
};

// ── Shared VerdictRow interface ─────────────────────────────────────────

/**
 * Superset VerdictRow interface covering all consumers.
 *
 * Fields marked optional are not present in every API response or consumer.
 * Individual consumers may narrow this type as needed.
 */
export interface VerdictRow {
  recordType: string;
  recordId: string;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number | null;
  needsRecheck: boolean | null;
  lastComputedAt: string | null;
  /** Present in SourcingStatus and entity-sourcing views */
  fieldName?: string | null;
  /** Present in SourcingStatus and entity-sourcing views */
  entityId?: string | null;
  /** Present in action-queue */
  nextCheckDue?: string | null;
  /** Present in entity-sourcing-viewer */
  createdAt?: string | null;
  /** Present in entity-sourcing-viewer */
  updatedAt?: string | null;
}

/** Response shape for verdict list endpoints. */
export interface VerdictsResponse {
  verdicts: VerdictRow[];
  total: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Look up a sourcing verdict style, falling back to `unchecked`. */
export function getSourcingVerdictStyle(verdict: string): SourcingVerdictStyle {
  return SOURCE_CHECK_VERDICT_STYLES[verdict as SourcingVerdictType] ?? SOURCE_CHECK_VERDICT_STYLES.unchecked;
}
