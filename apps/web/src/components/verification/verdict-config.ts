/**
 * Shared configuration for source-check verdict display.
 *
 * Separate from the citation/FactBase verdict vocabulary (accurate, minor_issues, etc.).
 * Source-check verdicts apply to structured records (grants, personnel, etc.).
 */

export type SourceCheckVerdict =
  | "confirmed"
  | "contradicted"
  | "outdated"
  | "partial"
  | "unverifiable";

export interface VerdictDisplayConfig {
  color: string;
  label: string;
  textColor: string;
}

export const SOURCE_CHECK_VERDICT_CONFIG: Record<
  SourceCheckVerdict,
  VerdictDisplayConfig
> = {
  confirmed: {
    color: "bg-emerald-500",
    label: "Verified",
    textColor: "text-emerald-700 dark:text-emerald-400",
  },
  contradicted: {
    color: "bg-red-500",
    label: "Contradicted",
    textColor: "text-red-700 dark:text-red-400",
  },
  outdated: {
    color: "bg-amber-500",
    label: "Outdated",
    textColor: "text-amber-700 dark:text-amber-400",
  },
  partial: {
    color: "bg-blue-400",
    label: "Partial",
    textColor: "text-blue-700 dark:text-blue-400",
  },
  unverifiable: {
    color: "bg-muted-foreground/40",
    label: "Unverifiable",
    textColor: "text-muted-foreground",
  },
} as const;
