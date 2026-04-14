/**
 * OpenAlex Deterministic Matcher — QUA-427.
 *
 * Verifies personnel records against [OpenAlex](https://openalex.org/), a free
 * structured academic database. For a personnel record like
 *   "Amanda Askell at Anthropic, Character Lead (2022–present)"
 * OpenAlex has the author → institutional-affiliation-by-year data sourced from
 * paper metadata. If the claimed affiliation is present, we can confirm the
 * record without fetching HTML or calling an LLM.
 *
 * Rationale: ~40-50% of AI-safety personnel in this wiki publish research, so
 * OpenAlex has them. The transplant pattern is `crux/lib/sourcing/wikidata-matcher.ts`
 * — both query a structured API, map the response to claims, and return a
 * definitive verdict without any LLM involvement.
 *
 * Cost: $0 (free API, no key required, ~100K queries/day soft limit). Replaces
 * LLM cost for records where the match succeeds.
 *
 * Phase 1 (this file): personnel only. Non-publishing personnel (exec, policy,
 * comms, ops) have no OpenAlex record and fall through to LLM as today.
 *
 * Explicitly NOT built: LinkedIn scraping. See QUA-427 for the legal/technical
 * rationale — OpenAlex is the right primary for researchers, the team-page
 * crawler (QUA-428) is the complementary fix for non-publishing personnel.
 */

import type { VerifyItem, VerifyResult, RecordItemData } from './orchestrator-types.ts';
import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import { nameMatches } from './fuzzy-match.ts';

// ── Constants ───────────────────────────────────────────────────────

const OPENALEX_BASE = 'https://api.openalex.org';

/**
 * OpenAlex asks callers to identify themselves via a mailto in the User-Agent
 * so the polite pool gives higher soft rate limits. A mailto is optional but
 * recommended per https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 */
const USER_AGENT =
  'LongtermWiki-Sourcing/1.0 (https://longtermwiki.com; mailto:noreply@longtermwiki.com)';

/**
 * Year slack around a personnel `startDate` when checking whether an OpenAlex
 * affiliation "covers" the claim. OpenAlex lags ~3-6 months behind publication
 * and a person's first paper from a new org usually lands ~6-12 months after
 * they join, so ±2 years is loose enough to avoid false contradicts while
 * still catching clearly-wrong year claims.
 */
const YEAR_SLACK = 2;

/** Cap search results per author lookup. More than 25 rarely disambiguates. */
const MAX_SEARCH_RESULTS = 25;

/** fetch timeout for the OpenAlex API. */
const FETCH_TIMEOUT_MS = 15_000;

// ── Types (subset of the OpenAlex author response) ─────────────────

export interface OpenAlexAffiliation {
  institution: {
    id: string;
    display_name: string;
    country_code?: string | null;
    type?: string | null;
  };
  years: number[];
}

export interface OpenAlexAuthor {
  /** OpenAlex URL-style ID, e.g. "https://openalex.org/A5012345678" */
  id: string;
  display_name: string;
  orcid?: string | null;
  works_count?: number;
  affiliations?: OpenAlexAffiliation[];
  last_known_institution?: {
    id: string;
    display_name: string;
  } | null;
}

interface OpenAlexSearchResponse {
  results?: OpenAlexAuthor[];
  meta?: { count: number };
}

// ── Cache (in-memory, per-process) ─────────────────────────────────

/**
 * Map from normalized author-name query → list of matching authors. null
 * means "we looked and got nothing / an error" so repeated lookups don't
 * re-hit the API within a single process run.
 *
 * The MVP uses an in-process cache only. A persistent `openalex_cache` PG
 * table with a weekly refresh is a follow-up; the ticket acceptance
 * criteria names it but a single orchestrator run is bounded enough that
 * in-memory is sufficient for the initial corpus pass.
 */
const authorCache = new Map<string, OpenAlexAuthor[] | null>();

/** Clear the in-memory cache. Test-only. */
export function clearAuthorCache(): void {
  authorCache.clear();
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Strip the OpenAlex URL prefix and return the short ID (e.g. "A5012345678").
 * Leaves inputs that are already short IDs alone.
 */
export function shortOpenAlexId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//i, '');
}

/**
 * Parse a 4-digit year out of a date-like string. Returns null for empty
 * or non-parseable inputs.
 */
export function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const match = dateStr.match(/(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}

/**
 * Search OpenAlex for authors by display name. Cached per-process.
 *
 * Returns [] on network error, 4xx/5xx, or when no results are found. The
 * caller can't distinguish these, which is intentional — all three mean
 * "OpenAlex can't help, fall through to LLM."
 */
export async function searchAuthors(name: string): Promise<OpenAlexAuthor[]> {
  const cacheKey = name.toLowerCase().trim();
  const cached = authorCache.get(cacheKey);
  if (cached !== undefined) return cached ?? [];

  const url = `${OPENALEX_BASE}/authors?search=${encodeURIComponent(name)}&per-page=${MAX_SEARCH_RESULTS}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[openalex-matcher] API returned ${response.status} for "${name}"`,
      );
      authorCache.set(cacheKey, null);
      return [];
    }

    const data = (await response.json()) as OpenAlexSearchResponse;
    const results = data.results ?? [];
    authorCache.set(cacheKey, results);
    return results;
  } catch (e: unknown) {
    console.warn(
      `[openalex-matcher] Fetch failed for "${name}": ${e instanceof Error ? e.message : String(e)}`,
    );
    authorCache.set(cacheKey, null);
    return [];
  }
}

/**
 * Disambiguate a candidate list to a single author using name + org context.
 *
 * Returns null when:
 * - no candidate passes the name filter (LLM fallback, the name is wrong
 *   or OpenAlex doesn't have them)
 * - multiple candidates pass the name filter AND none uniquely match the
 *   org context (ambiguous — LLM fallback is safer than guessing)
 */
export function pickBestAuthor(
  candidates: OpenAlexAuthor[],
  targetName: string,
  targetOrg: string,
): OpenAlexAuthor | null {
  const nameMatched = candidates.filter((c) => nameMatches(targetName, c.display_name));
  if (nameMatched.length === 0) return null;
  if (nameMatched.length === 1) return nameMatched[0];

  // Multiple name matches — use org as disambiguator. Return the first
  // whose affiliations or last_known_institution matches the target org.
  const orgMatches: OpenAlexAuthor[] = [];
  for (const c of nameMatched) {
    const hasAffMatch = (c.affiliations ?? []).some((aff) =>
      nameMatches(targetOrg, aff.institution.display_name),
    );
    const hasLkiMatch =
      c.last_known_institution != null &&
      nameMatches(targetOrg, c.last_known_institution.display_name);
    if (hasAffMatch || hasLkiMatch) orgMatches.push(c);
  }

  if (orgMatches.length === 1) return orgMatches[0];

  // Zero or multiple org matches — ambiguous.
  return null;
}

// ── Affiliation check ──────────────────────────────────────────────

export interface AffiliationCheckResult {
  /** Target org is present in the author's affiliations AND year window matches (if supplied). */
  matched: boolean;
  /** Target org not found in any affiliation. */
  wrongOrg: boolean;
  /** Target org found, but target year is outside the affiliation's year window. */
  wrongYear: boolean;
  /** The matched institution display name (if any). */
  matchedInstitution?: string;
  /** Display names of all affiliations on the author (for contradicted reasoning). */
  actualInstitutions: string[];
}

export function checkAffiliation(
  author: OpenAlexAuthor,
  targetOrg: string,
  targetYear: number | null,
): AffiliationCheckResult {
  const affiliations = author.affiliations ?? [];
  const actualInstitutions = affiliations.map((a) => a.institution.display_name);

  // Fall back to last_known_institution if we have no year-dated affiliations.
  if (affiliations.length === 0) {
    const lki = author.last_known_institution;
    if (lki) {
      const matches = nameMatches(targetOrg, lki.display_name);
      return {
        matched: matches,
        wrongOrg: !matches,
        wrongYear: false,
        matchedInstitution: matches ? lki.display_name : undefined,
        actualInstitutions: [lki.display_name],
      };
    }
    // No affiliations AND no last_known_institution — author exists but we
    // have no data to confirm OR contradict. That's unverifiable, not
    // contradicted; tryOpenAlexMatch reads all-false flags as "unverifiable".
    return {
      matched: false,
      wrongOrg: false,
      wrongYear: false,
      actualInstitutions: [],
    };
  }

  for (const aff of affiliations) {
    if (!nameMatches(targetOrg, aff.institution.display_name)) continue;

    // Org matches — check the year window if a target year was supplied.
    const years = aff.years ?? [];
    if (targetYear != null && years.length > 0) {
      const minYear = Math.min(...years);
      const maxYear = Math.max(...years);
      if (targetYear >= minYear - YEAR_SLACK && targetYear <= maxYear + YEAR_SLACK) {
        return {
          matched: true,
          wrongOrg: false,
          wrongYear: false,
          matchedInstitution: aff.institution.display_name,
          actualInstitutions,
        };
      }
      return {
        matched: false,
        wrongOrg: false,
        wrongYear: true,
        matchedInstitution: aff.institution.display_name,
        actualInstitutions,
      };
    }

    // Org matches, no year to enforce.
    return {
      matched: true,
      wrongOrg: false,
      wrongYear: false,
      matchedInstitution: aff.institution.display_name,
      actualInstitutions,
    };
  }

  // Target org is absent from all affiliations.
  return {
    matched: false,
    wrongOrg: true,
    wrongYear: false,
    actualInstitutions,
  };
}

// ── Main matcher ────────────────────────────────────────────────────

function makeResult(
  item: VerifyItem,
  verdict: SourcingVerdict,
  confidence: number,
  extractedValue: string,
  reasoning: string,
  sourceUrl: string,
): VerifyResult {
  return {
    itemId: item.id,
    kind: item.kind,
    description: item.description,
    verdict,
    confidence,
    extractedValue,
    reasoning,
    sourceUrl,
    checkerModel: 'openalex-api',
  };
}

/**
 * Try to verify a personnel record via OpenAlex.
 *
 * Returns:
 * - `VerifyResult` with a definitive verdict (confirmed / contradicted /
 *   unverifiable) when the author is found and affiliation data is available
 * - `null` when OpenAlex can't help (not personnel, missing name/org, author
 *   not found, ambiguous candidates, no publications). The caller then falls
 *   through to the LLM path.
 */
export async function tryOpenAlexMatch(item: VerifyItem): Promise<VerifyResult | null> {
  if (item.data.kind !== 'record') return null;
  const data = item.data as RecordItemData;
  if (data.recordType !== 'personnel') return null;

  const personName = data.fields.person;
  const orgName = data.fields.org;
  const startDate = data.fields.startDate;

  if (typeof personName !== 'string' || personName.length === 0 || personName === '(unknown)') {
    return null;
  }
  if (typeof orgName !== 'string' || orgName.length === 0 || orgName === '(unknown)') {
    return null;
  }

  const candidates = await searchAuthors(personName);
  if (candidates.length === 0) return null;

  const best = pickBestAuthor(candidates, personName, orgName);
  if (!best) return null;

  // Non-publishing personnel (exec, comms, ops) will either not appear in
  // OpenAlex at all (candidates.length === 0 above) or appear as a stub
  // author with works_count === 0 (e.g. someone acknowledged but never an
  // author). Don't trust a stub record's affiliation data.
  if ((best.works_count ?? 0) === 0) return null;

  const targetYear = extractYear(typeof startDate === 'string' ? startDate : null);
  const aff = checkAffiliation(best, orgName, targetYear);
  const shortId = shortOpenAlexId(best.id);
  const sourceUrl = best.id;
  const yearSuffix = targetYear != null ? ` (target year ${targetYear})` : '';

  if (aff.matched) {
    return makeResult(
      item,
      'confirmed',
      0.95,
      `${best.display_name} → ${aff.matchedInstitution}`,
      `[openalex-api] OpenAlex ${shortId} (${best.display_name}) affiliated with ${aff.matchedInstitution}${yearSuffix}`,
      sourceUrl,
    );
  }

  if (aff.wrongYear) {
    return makeResult(
      item,
      'contradicted',
      0.85,
      `${best.display_name} at ${aff.matchedInstitution} — year ${targetYear} outside affiliation window`,
      `[openalex-api] OpenAlex ${shortId} confirms ${best.display_name} at ${aff.matchedInstitution}, but the years on that affiliation do not cover target year ${targetYear} (±${YEAR_SLACK} slack applied)`,
      sourceUrl,
    );
  }

  if (aff.wrongOrg) {
    const actual =
      aff.actualInstitutions.length > 0
        ? aff.actualInstitutions.join(', ')
        : '(no affiliation data)';
    return makeResult(
      item,
      'contradicted',
      0.85,
      `${best.display_name} → ${actual}`,
      `[openalex-api] OpenAlex ${shortId} (${best.display_name}) affiliations [${actual}] do not include "${orgName}"`,
      sourceUrl,
    );
  }

  // Reached when the author exists but has no usable affiliation data.
  return makeResult(
    item,
    'unverifiable',
    0.8,
    '',
    `[openalex-api] OpenAlex ${shortId} (${best.display_name}) has no affiliation data`,
    sourceUrl,
  );
}
