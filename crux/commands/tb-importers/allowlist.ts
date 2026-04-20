/**
 * T1 authority allowlist (QUA-640).
 *
 * Maps `(source-prefix, recordType)` tuples to "this combo is authoritative —
 * the propose endpoint may write a `confirmed` verdict without an LLM call".
 *
 * The propose endpoint (QUA-632) is the enforcement point. This module is the
 * source of truth that both the importers and the endpoint import from.
 *
 * Adding a new entry here is a deliberate trust decision: the source must be a
 * primary, deterministic source for the record type. Examples:
 *   - SEC EDGAR Form D filings → funding-rounds (regulatory filings, structured)
 *   - GitHub contributors API → personnel (org-controlled access lists, structured)
 *   - HuggingFace Open LLM Leaderboard → benchmark-results (auto-eval pipeline output)
 *
 * Things that are NOT T1 (and would be rejected by the gate even if listed
 * here): wikipedia, blog posts, press releases, anything LLM-summarized.
 */

import type { EnrichmentRecordType } from "./types.ts";

export interface T1AuthorityEntry {
  /** Prefix matched against `proposal.source`. e.g. "sec-edgar:" matches "sec-edgar:0001234..." */
  sourcePrefix: string;
  recordType: EnrichmentRecordType;
  /** Human-readable description (shown in audit logs). */
  description: string;
}

export const T1_AUTHORITY_ALLOWLIST: readonly T1AuthorityEntry[] = [
  {
    sourcePrefix: "sec-edgar:",
    recordType: "funding-round",
    description:
      "SEC EDGAR Form D filings (regulatory filings of US private offerings).",
  },
  {
    sourcePrefix: "github-contributors:",
    recordType: "personnel",
    description:
      "GitHub contributors API for org-owned repositories (≥N commit threshold).",
  },
  {
    sourcePrefix: "hf-leaderboard:",
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
