/**
 * Unified sourcing status model.
 *
 * Maps all existing sourcing vocabularies (TableBase verdicts, FactBase verdicts)
 * into a single 5-state model for display.
 *
 * States:
 *   not_run  — Check hasn't been executed yet (white dot)
 *   error    — System error, check couldn't complete (black dot)
 *   failed   — Source actively contradicted the claim, or checker tried and could not
 *              confirm it (red dot)
 *   trouble  — Partially verified, outdated, or other actionable concerns (amber dot)
 *   verified — Successfully verified (green dot)
 */

export type SourcingStatus =
  | "not_run"
  | "error"
  | "failed"
  | "trouble"
  | "verified";

export interface SourcingStatusConfig {
  /** Tailwind bg class for the dot */
  dotColor: string;
  /** Tailwind border class (used for "not_run" to make white visible) */
  borderColor: string;
  /** Human-readable label for tooltip */
  label: string;
}

export const SOURCE_CHECK_STATUS_CONFIG: Record<
  SourcingStatus,
  SourcingStatusConfig
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

/** Verdicts from the sourcing system for structured records (grants, personnel, etc.) */
const RECORD_VERDICT_MAP: Record<string, SourcingStatus> = {
  confirmed: "verified",
  contradicted: "failed",
  outdated: "trouble",
  partial: "trouble",
  // "Unverifiable" = the checker actively tried to verify and could not.
  // That's a stronger negative signal than "partial" (some support found) —
  // surface it as failed (red), not trouble (amber).
  unverifiable: "failed",
  // QUA-426: pre-LLM relevance-gate short-circuit — the source didn't even
  // mention the record's subject, so neither confirmation nor contradiction
  // is possible. Render as neutral "not checked", not as "trouble".
  not_applicable: "not_run",
};

/**
 * Map a TableBase record verdict string to a SourcingStatus.
 * Returns "not_run" for null/undefined/unknown values.
 */
export function recordVerdictToStatus(
  verdict: string | null | undefined,
): SourcingStatus {
  if (!verdict) return "not_run";
  return RECORD_VERDICT_MAP[verdict] ?? "not_run";
}

// ── Mapping from FactBase (citation) verdicts ───────────────────────

/** Verdicts from the citation sourcing system for KB facts */
const FACTBASE_VERDICT_MAP: Record<string, SourcingStatus> = {
  accurate: "verified",
  verified: "verified",
  minor_issues: "trouble",
  inaccurate: "failed",
  unsupported: "failed",
  // Parallel to the TableBase `unverifiable` mapping: when the citation checker
  // tried and couldn't verify, surface as failed (red), not trouble (amber).
  not_verifiable: "failed",
};

/**
 * Map a FactBase fact verdict string to a SourcingStatus.
 * Returns "not_run" for null/undefined/unknown values.
 */
export function factbaseVerdictToStatus(
  verdict: string | null | undefined,
): SourcingStatus {
  if (!verdict) return "not_run";
  return FACTBASE_VERDICT_MAP[verdict] ?? "not_run";
}
