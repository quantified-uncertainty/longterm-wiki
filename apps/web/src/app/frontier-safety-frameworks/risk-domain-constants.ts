/**
 * Canonical risk domains used across all frontier-safety frameworks.
 * Mirrors the CHECK constraint allowlist in
 * `apps/wiki-server/drizzle/0206_*` and the validators in
 * `framework-capability-thresholds.ts` / `framework-diff-items.ts`.
 */

export const CANONICAL_RISK_DOMAINS = [
  "cbrn",
  "bio",
  "chem",
  "nuclear",
  "radiological",
  "cyber",
  "autonomy_replication",
  "ai_rd",
  "scheming",
  "persuasion",
  "loss_of_control",
  "other",
] as const;

export type CanonicalRiskDomain = (typeof CANONICAL_RISK_DOMAINS)[number];

export const RISK_DOMAIN_LABELS: Record<CanonicalRiskDomain, string> = {
  cbrn: "CBRN",
  bio: "Bio",
  chem: "Chem",
  nuclear: "Nuclear",
  radiological: "Radiological",
  cyber: "Cyber",
  autonomy_replication: "Autonomy & Replication",
  ai_rd: "AI R&D",
  scheming: "Scheming",
  persuasion: "Persuasion",
  loss_of_control: "Loss of Control",
  other: "Other",
};

export const RISK_DOMAIN_SHORT_LABELS: Record<CanonicalRiskDomain, string> = {
  cbrn: "CBRN",
  bio: "Bio",
  chem: "Chem",
  nuclear: "Nuc",
  radiological: "Rad",
  cyber: "Cyber",
  autonomy_replication: "Auto",
  ai_rd: "R&D",
  scheming: "Scheme",
  persuasion: "Persuade",
  loss_of_control: "LoC",
  other: "Other",
};

/**
 * Tier color tokens — keyed by `tier_sort_order` (1 = lowest, 5 = severe).
 * Reused for matrix cells and detail-page tier pills.
 */
export const TIER_COLORS: Record<number, { bg: string; text: string; border: string }> = {
  1: { bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-800 dark:text-emerald-200", border: "border-emerald-300 dark:border-emerald-700" },
  2: { bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-900 dark:text-amber-200", border: "border-amber-300 dark:border-amber-700" },
  3: { bg: "bg-orange-50 dark:bg-orange-950/40", text: "text-orange-900 dark:text-orange-200", border: "border-orange-300 dark:border-orange-700" },
  4: { bg: "bg-red-50 dark:bg-red-950/40", text: "text-red-900 dark:text-red-200", border: "border-red-300 dark:border-red-700" },
  5: { bg: "bg-rose-100 dark:bg-rose-950/50", text: "text-rose-900 dark:text-rose-200", border: "border-rose-400 dark:border-rose-700" },
};

export function tierColor(sortOrder: number | null | undefined) {
  if (sortOrder == null) {
    return { bg: "bg-muted/30", text: "text-muted-foreground", border: "border-border/40" };
  }
  return TIER_COLORS[sortOrder] ?? TIER_COLORS[3];
}

/**
 * Public-facing label for the diff `review_verdict`. Critical: "unreviewed"
 * diffs must NEVER show "weakened" / "strengthened" labels — only the raw
 * factual change list. See QUA-709 acceptance criteria.
 */
export const REVIEW_VERDICT_LABELS: Record<string, string> = {
  confirmed_weakening: "Confirmed weakening",
  confirmed_strengthening: "Confirmed strengthening",
  nuanced: "Nuanced",
  false_positive: "Reviewed — no material change",
  unreviewed: "Pending review",
};

/**
 * Returns true when a diff's verdict is published-safe to render with a
 * directional summary ("weakened"/"strengthened"). Falsy verdicts and
 * "unreviewed" return false — UI must show the factual change list only.
 */
export function isVerdictPublished(reviewVerdict: string | null | undefined): boolean {
  return (
    reviewVerdict === "confirmed_weakening" ||
    reviewVerdict === "confirmed_strengthening" ||
    reviewVerdict === "nuanced"
  );
}
