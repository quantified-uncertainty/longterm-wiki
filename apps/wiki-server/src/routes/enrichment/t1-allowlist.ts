/**
 * QUA-632 Phase 1 — T1 Authority Allowlist.
 *
 * A T1 source is a deterministic, authoritative data source where the act of
 * matching the URL + record-type is itself the verification.  No verdict-LLM
 * call is made: the source's authority *is* the verdict.
 *
 * Adding an entry below is a declaration that: for rows of this `recordType`
 * (optionally a specific `fieldName`), a URL matching this pattern IS
 * confirmation.  Add sparingly and only after auditing the source.
 *
 * Each entry has a stable `id` that is recorded in
 * `source_check_evidence.checker_model` as `t1-<id>` so T1-written rows are
 * auditable and re-runnable.
 */

export interface T1Source {
  /** Stable identifier used in evidence.checker_model (`t1-<id>`). */
  id: string;
  /** Human-readable label used in audit reasoning. */
  name: string;
  /** Regex matched against the full source URL. */
  urlPattern: RegExp;
  /**
   * Record types this source is authoritative for.  A request with a
   * recordType not in this list falls through to the next entry (and
   * ultimately to rejection).
   */
  recordTypes: string[];
  /**
   * Optional per-field restriction.  When set for a recordType, the request's
   * `fieldName` must be null OR one of the listed field names to match.
   * When unset, the source is row-level authoritative for the whole record.
   */
  fields?: Record<string, string[]>;
}

/**
 * The allowlist.  Ordered from most-specific to least-specific; first match
 * wins.  The current list seeds the six T1 sources named in the QUA-637
 * umbrella; Phase 1 only exercises the subset that has sync-route support
 * registered in `enrichment.ts`.
 */
export const T1_ALLOWLIST: T1Source[] = [
  {
    id: "ea-funds",
    name: "EA Funds",
    // Covers the grants listing pages + direct CSV downloads.
    urlPattern: /^https:\/\/funds\.effectivealtruism\.org\//i,
    recordTypes: ["grants"],
  },
  {
    id: "coefficient-giving",
    name: "Coefficient Giving (fka Open Philanthropy) — grant database",
    urlPattern: /^https:\/\/(www\.)?coefficientgiving\.org\/grants(\/|$)/i,
    recordTypes: ["grants"],
  },
  {
    id: "openalex",
    name: "OpenAlex API",
    urlPattern: /^https:\/\/api\.openalex\.org\//i,
    recordTypes: ["personnel", "publications"],
  },
  {
    id: "wikidata",
    name: "Wikidata",
    urlPattern: /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+/i,
    recordTypes: ["personnel", "organization"],
  },
  {
    id: "sec-edgar",
    name: "SEC EDGAR",
    urlPattern: /^https:\/\/(www\.)?sec\.gov\/(cgi-bin\/browse-edgar|Archives\/edgar)\//i,
    recordTypes: ["funding-rounds", "organization"],
  },
  {
    id: "hf-leaderboard",
    name: "Hugging Face Leaderboard",
    // Leaderboard "row" query-string URLs are also accepted — the datasets-server
    // deep-links use ?row=<evalName> (see hf-leaderboard importer).
    urlPattern: /^https:\/\/huggingface\.co\/spaces\/[^/]+\/[^/]*leaderboard/i,
    // Maps to the `benchmark-results` sync route (auto-eval scores), not the
    // `benchmarks` definition table.
    recordTypes: ["benchmark-results"],
  },
  {
    id: "github-api",
    name: "GitHub API",
    urlPattern: /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(contributors|collaborators)/i,
    recordTypes: ["personnel"],
  },
  {
    // Public GitHub URLs surfaced by the github-contributors importer (T1).
    // The contributors API hits `api.github.com` above; the per-user profile
    // URLs written into `proposal.sourceUrl` live under github.com itself.
    //
    // Pattern excludes GitHub's reserved single-segment paths (settings,
    // marketplace, orgs, etc.) — those aren't user profiles and must never
    // be accepted as authoritative sources for personnel records.  The
    // downstream github-contributors importer also independently knows the
    // URL is a real user profile because it was surfaced by the contributors
    // API, but this allowlist is meant to be an independent gate.
    id: "github-user",
    name: "GitHub user profile (via contributors importer)",
    urlPattern:
      /^https:\/\/github\.com\/(?!(settings|marketplace|orgs|about|pulls|issues|explore|topics|trending|notifications|new|login|signup|join|search|sponsors|features|pricing|customer-stories|security|enterprise|team|collections|codespaces|dashboard|blog|help|site|contact)(\/|$))[A-Za-z0-9][A-Za-z0-9-]{0,38}\/?$/i,
    recordTypes: ["personnel"],
  },
];

export type T1MatchResult =
  | { matched: true; source: T1Source }
  | { matched: false; reason: string };

/**
 * Check whether `(sourceUrl, recordType, fieldName?)` is on the T1 allowlist.
 * Returns the matched source on success or a human-readable reason on miss.
 *
 * `fieldName` = null means "row-level" / "whole record"; only sources without a
 * `fields[recordType]` restriction match that case.
 */
export function checkT1Authority(
  sourceUrl: string,
  recordType: string,
  fieldName: string | null,
): T1MatchResult {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    return { matched: false, reason: "sourceUrl is empty" };
  }

  for (const source of T1_ALLOWLIST) {
    if (!source.urlPattern.test(sourceUrl)) continue;
    if (!source.recordTypes.includes(recordType)) continue;

    const fieldRestriction = source.fields?.[recordType];
    if (fieldRestriction) {
      if (fieldName === null) continue;
      if (!fieldRestriction.includes(fieldName)) continue;
    }

    return { matched: true, source };
  }

  return {
    matched: false,
    reason: `No T1 authority matches (url=${truncate(sourceUrl, 120)}, recordType=${recordType}, fieldName=${fieldName ?? "<row>"})`,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
