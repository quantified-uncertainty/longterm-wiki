/**
 * Verification status badge for structured data records (grants, personnel, etc.).
 *
 * Shows a small colored indicator next to record data points on detail pages.
 * The verdict comes from the record verification system (wiki-server + LLM checks).
 *
 * Only renders when a verdict exists — unchecked records show nothing.
 */
import type { RecordVerdict } from "@data/tablebase";

// ── Verdict display config ───────────────────────────────────────────

interface VerdictConfig {
  label: string;
  /** Short tooltip description */
  title: string;
  className: string;
}

const VERDICT_CONFIG: Record<string, VerdictConfig> = {
  confirmed: {
    label: "Verified",
    title: "Confirmed by source",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  contradicted: {
    label: "Disputed",
    title: "Source contradicts this data",
    className:
      "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  },
  outdated: {
    label: "Outdated",
    title: "Source has newer data",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  partial: {
    label: "Partial",
    title: "Partially confirmed by source",
    className:
      "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  },
  unverifiable: {
    label: "Unverifiable",
    title: "Source does not address this data",
    className:
      "bg-gray-100 text-gray-500 dark:bg-gray-800/40 dark:text-gray-400",
  },
};

// ── Component ────────────────────────────────────────────────────────

export function VerificationBadge({
  verdict,
}: {
  verdict: RecordVerdict | null | undefined;
}) {
  if (!verdict) return null;

  const config = VERDICT_CONFIG[verdict.verdict];
  if (!config) return null;

  // Build confidence suffix if available
  const confidencePct =
    verdict.confidence != null
      ? `${Math.round(verdict.confidence * 100)}%`
      : null;

  const titleText = confidencePct
    ? `${config.title} (${confidencePct} confidence)`
    : config.title;

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ${config.className}`}
      title={titleText}
    >
      {config.label}
    </span>
  );
}

// ── Mapping helper ───────────────────────────────────────────────────

/**
 * Map a KB record collection name to the verification record type.
 * Returns null for collections that don't have verification support.
 */
export function collectionToRecordType(
  collection: string,
): string | null {
  const MAP: Record<string, string> = {
    grants: "grant",
    personnel: "personnel",
    divisions: "division",
    "funding-programs": "funding-program",
    "funding-rounds": "funding-round",
    investments: "investment",
    "equity-positions": "equity-position",
  };
  return MAP[collection] ?? null;
}

/**
 * Map a KB record schema to the verification record type.
 * Handles personnel subtypes (key-person, board-seat, career-history all map to "personnel").
 */
export function schemaToRecordType(schema: string): string | null {
  const MAP: Record<string, string> = {
    grant: "grant",
    "key-person": "personnel",
    "board-seat": "personnel",
    "career-history": "personnel",
    division: "division",
    "funding-program": "funding-program",
    "funding-round": "funding-round",
    investment: "investment",
    "equity-position": "equity-position",
    "division-personnel": "personnel",
  };
  return MAP[schema] ?? null;
}
