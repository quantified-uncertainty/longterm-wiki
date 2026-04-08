/**
 * Unified source-check status model.
 *
 * Maps all existing source-check vocabularies (TableBase verdicts, FactBase verdicts)
 * into a single 5-state model for display.
 *
 * States:
 *   not_run  — Check hasn't been executed yet (white dot)
 *   error    — System error, check couldn't complete (black dot)
 *   failed   — Checked but couldn't verify the claim (red dot)
 *   trouble  — Partially verified or concerns found (orange dot)
 *   verified — Successfully verified (green dot)
 */

export type SourceCheckStatus =
  | "not_run"
  | "error"
  | "failed"
  | "trouble"
  | "verified";

export interface SourceCheckStatusConfig {
  /** Tailwind bg class for the dot */
  dotColor: string;
  /** Tailwind border class (used for "not_run" to make white visible) */
  borderColor: string;
  /** Human-readable label for tooltip */
  label: string;
}

export const SOURCE_CHECK_STATUS_CONFIG: Record<
  SourceCheckStatus,
  SourceCheckStatusConfig
> = {
  not_run: {
    dotColor: "bg-white dark:bg-zinc-700",
    borderColor: "border border-gray-300 dark:border-zinc-500",
    label: "Not checked",
  },
  error: {
    dotColor: "bg-gray-900 dark:bg-gray-100",
    borderColor: "",
    label: "Error",
  },
  failed: {
    dotColor: "bg-red-500",
    borderColor: "",
    label: "Failed source check",
  },
  trouble: {
    dotColor: "bg-amber-500",
    borderColor: "",
    label: "Needs attention",
  },
  verified: {
    dotColor: "bg-emerald-500",
    borderColor: "",
    label: "Verified",
  },
};

// ── Mapping from TableBase (record) verdicts ────────────────────────

/** Verdicts from the source-check system for structured records (grants, personnel, etc.) */
const RECORD_VERDICT_MAP: Record<string, SourceCheckStatus> = {
  confirmed: "verified",
  contradicted: "failed",
  outdated: "trouble",
  partial: "trouble",
  unverifiable: "failed",
};

/**
 * Map a TableBase record verdict string to a SourceCheckStatus.
 * Returns "not_run" for null/undefined/unknown values.
 */
export function recordVerdictToStatus(
  verdict: string | null | undefined,
): SourceCheckStatus {
  if (!verdict) return "not_run";
  return RECORD_VERDICT_MAP[verdict] ?? "not_run";
}

// ── Mapping from FactBase (citation) verdicts ───────────────────────

/** Verdicts from the citation source-check system for KB facts */
const FACTBASE_VERDICT_MAP: Record<string, SourceCheckStatus> = {
  accurate: "verified",
  verified: "verified",
  minor_issues: "trouble",
  inaccurate: "failed",
  unsupported: "failed",
  not_verifiable: "failed",
};

/**
 * Map a FactBase fact verdict string to a SourceCheckStatus.
 * Returns "not_run" for null/undefined/unknown values.
 */
export function factbaseVerdictToStatus(
  verdict: string | null | undefined,
): SourceCheckStatus {
  if (!verdict) return "not_run";
  return FACTBASE_VERDICT_MAP[verdict] ?? "not_run";
}
