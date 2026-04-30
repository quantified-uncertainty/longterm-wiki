/**
 * Display metadata for the five external scorecard sources tracked by
 * QUA-688 Phase 1. Order is the order columns appear in the matrix.
 */

export interface ScorecardSourceMeta {
  /** Enum value used in PG / sync API. */
  source: ScorecardSourceKey;
  /** Short display label for headers and pills. */
  shortLabel: string;
  /** Full display label for tooltips and methodology panels. */
  fullLabel: string;
  /** Org/maintainer of the scorecard. */
  publisher: string;
  /**
   * Slug for /organizations/<slug> linking when the publisher has a wiki
   * entity. Optional — sources whose publisher isn't yet in the catalog
   * render the publisher as plain text.
   */
  publisherSlug?: string;
  /** Default canonical URL for the source's home page. */
  homeUrl: string;
  /**
   * One-line description for the methodology / "about this scorecard" panel.
   * Keep neutral, factual; surfaced verbatim on the directory page.
   */
  description: string;
  /**
   * Whether the source is still actively updated. Mirrors
   * `scorecard_snapshots.source_active` for display defaults.
   */
  active: boolean;
}

export type ScorecardSourceKey =
  | "fli_index"
  | "saferai"
  | "ailabwatch"
  | "fmti"
  | "seoul_tracker";

export const SCORECARD_SOURCES: readonly ScorecardSourceMeta[] = [
  {
    source: "fli_index",
    shortLabel: "FLI Index",
    fullLabel: "FLI AI Safety Index",
    publisher: "Future of Life Institute",
    publisherSlug: "fli",
    homeUrl: "https://futureoflife.org/ai-safety-index-summer-2025/",
    description:
      "Letter-grade ratings of frontier AI labs across six safety domains: risk assessment, current harms, safety frameworks, existential safety, governance, and information sharing.",
    active: true,
  },
  {
    source: "saferai",
    shortLabel: "SaferAI",
    fullLabel: "SaferAI Ratings",
    publisher: "SaferAI",
    homeUrl: "https://ratings.safer-ai.org",
    description:
      "Continuously-updated risk-management ratings for frontier developers across four pillars: risk identification, analysis & evaluation, treatment, and governance.",
    active: true,
  },
  {
    source: "ailabwatch",
    shortLabel: "AI Lab Watch",
    fullLabel: "AI Lab Watch",
    publisher: "Zach Stein-Perlman",
    homeUrl: "https://ailabwatch.org",
    description:
      "Weighted scorecard across seven categories (risk assessment, scheming prevention, safety research, misuse prevention, security, info sharing, planning).",
    active: false,
  },
  {
    source: "fmti",
    shortLabel: "FMTI",
    fullLabel: "Foundation Model Transparency Index",
    publisher: "Stanford CRFM",
    homeUrl: "https://crfm.stanford.edu/fmti/",
    description:
      "Transparency-focused index scoring developers on 100 indicators across upstream resources, the model itself, and downstream use.",
    active: true,
  },
  {
    source: "seoul_tracker",
    shortLabel: "Seoul Tracker",
    fullLabel: "Seoul Commitment Tracker",
    publisher: "The Midas Project",
    homeUrl: "https://www.seoul-tracker.org",
    description:
      "Tracks adherence to the Seoul Frontier AI Safety Commitments via 'Fulfilled / Partial / Unfulfilled' verdicts on five red-line components.",
    active: true,
  },
] as const;

/**
 * Look up display metadata for a scorecard source. Returns null when the
 * source key is unknown — caller should display a fallback (raw string).
 */
export function getScorecardSourceMeta(
  source: string,
): ScorecardSourceMeta | null {
  return SCORECARD_SOURCES.find((meta) => meta.source === source) ?? null;
}

/**
 * Slug used for the per-(org, source) aggregate row in `scorecard_grades`.
 * Sibling rows hold per-dimension grades; the aggregate is treated as a
 * regular dimension to keep matrix queries uniform.
 */
export const DIMENSION_OVERALL = "overall";

/**
 * Render the user-visible cell text for a scorecard grade. Letter grades
 * win when present (sources like FLI publish letters); numeric falls back
 * to the raw string from the source for audit fidelity.
 */
export function formatScoreCell(cell: {
  scoreLetter: string | null;
  scoreNumeric: number | null;
  scoreRaw: string;
}): string {
  return (
    cell.scoreLetter ??
    (cell.scoreNumeric != null ? String(cell.scoreNumeric) : cell.scoreRaw)
  );
}
