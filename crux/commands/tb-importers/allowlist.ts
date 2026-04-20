/**
 * T1 authority allowlist (QUA-640).
 *
 * Maps `(source-prefix, recordType)` tuples to "this combo is authoritative —
 * the propose endpoint may write a `confirmed` verdict without an LLM call".
 *
 * The propose endpoint (QUA-632) is the enforcement point. This module is the
 * source of truth that both the importers and the endpoint import from —
 * including the prefix constants themselves, so a renamed prefix can't drift
 * out of sync between the importer's `proposal.source` and the allowlist.
 */

import type { EnrichmentRecordType } from "./types.ts";

/**
 * Canonical source-prefix strings. Importers MUST construct
 * `proposal.source` as `${T1_SOURCE_PREFIXES.X}${id}` so renames
 * propagate to the allowlist automatically.
 */
export const T1_SOURCE_PREFIXES = {
  secEdgar: "sec-edgar:",
  githubContributors: "github-contributors:",
  hfLeaderboard: "hf-leaderboard:",
} as const;

export interface T1AuthorityEntry {
  /** Prefix matched against `proposal.source`. */
  sourcePrefix: string;
  recordType: EnrichmentRecordType;
  /** Human-readable description (shown in audit logs). */
  description: string;
}

export const T1_AUTHORITY_ALLOWLIST: readonly T1AuthorityEntry[] = [
  {
    sourcePrefix: T1_SOURCE_PREFIXES.secEdgar,
    recordType: "funding-round",
    description:
      "SEC EDGAR Form D filings (regulatory filings of US private offerings).",
  },
  {
    sourcePrefix: T1_SOURCE_PREFIXES.githubContributors,
    recordType: "personnel",
    description:
      "GitHub contributors API for org-owned repositories (≥N commit threshold).",
  },
  {
    sourcePrefix: T1_SOURCE_PREFIXES.hfLeaderboard,
    recordType: "benchmark-result",
    description:
      "HuggingFace Open LLM Leaderboard (deterministic auto-eval pipeline).",
  },
] as const;

/**
 * Returns true if `(source, recordType)` is on the T1 allowlist.
 * Source matching is by prefix — `sec-edgar:0001234567-25-000001` matches `sec-edgar:`.
 */
export function isT1Authoritative(
  source: string,
  recordType: EnrichmentRecordType
): boolean {
  return T1_AUTHORITY_ALLOWLIST.some(
    (entry) =>
      entry.recordType === recordType && source.startsWith(entry.sourcePrefix)
  );
}
