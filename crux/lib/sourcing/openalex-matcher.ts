/**
 * OpenAlex deterministic matcher for personnel records — mirrors
 * `wikidata-matcher.ts` but queries OpenAlex author → institution data.
 * Returns null for non-publishing personnel and homonym-risk cases so the
 * caller falls through to LLM verification.
 */

import type { VerifyItem, VerifyResult, RecordItemData } from './orchestrator-types.ts';
import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import { nameMatches } from './fuzzy-match.ts';
import { isResolvableName } from './record-fields.ts';

// ── Constants ───────────────────────────────────────────────────────

const OPENALEX_BASE = 'https://api.openalex.org';

/**
 * Polite-pool mailto per OpenAlex's rate-limit docs. Optional but recommended.
 */
const USER_AGENT =
  'LongtermWiki-Sourcing/1.0 (https://longtermwiki.com; mailto:noreply@longtermwiki.com)';

// Asymmetric year slack for the affiliation window check: researchers
// typically join an org 6–18 months before their first paper with the new
// affiliation lands, so the lower bound is wider than the upper. A claim
// year well after the last paper is genuinely suspicious.
const YEAR_SLACK_LOW = 3;
const YEAR_SLACK_HIGH = 2;

const MAX_SEARCH_RESULTS = 25;
const FETCH_TIMEOUT_MS = 15_000;

// Confidence scoring — deliberately conservative because the matcher can't
// always rule out homonyms. A wrong high-confidence verdict would overwrite
// curated evidence, so single-candidate contradicted paths fall through to
// LLM (see `tryOpenAlexMatch`).
const CONFIDENCE_CONFIRMED = 0.9;
const CONFIDENCE_CONTRADICTED = 0.65;
const CONFIDENCE_UNVERIFIABLE = 0.8;

/** Reject `works_count === 0` entries — they're usually acknowledgment stubs. */
const MIN_WORKS_COUNT = 1;

const CHECKER_MODEL = 'openalex-api';

// Cut OpenAlex response payload by ~5-10x by projecting only the fields
// we actually read. 500 personnel × full-author JSON is ~125-500KB per run
// without this.
const SELECT_FIELDS = [
  'id',
  'display_name',
  'orcid',
  'works_count',
  'affiliations',
  'last_known_institution',
].join(',');

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

// Map from normalized name → author list (null = "looked and got nothing").
// Bounded by the number of unique personnel names in a single orchestrator run.
const authorCache = new Map<string, OpenAlexAuthor[] | null>();

// In-flight request dedup: populated synchronously before `await fetch`, so
// two concurrent personnel with the same name under `concurrency=8` share a
// single network round-trip instead of racing on the post-await cache write.
const inFlightRequests = new Map<string, Promise<OpenAlexAuthor[]>>();

/** @internal Test-only helper to reset the matcher's process-lifetime cache. */
export function clearAuthorCache(): void {
  authorCache.clear();
  inFlightRequests.clear();
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
 * Search OpenAlex for authors by display name. Cached per-process; concurrent
 * requests for the same name share a single fetch.
 *
 * Returns [] on network error, 4xx/5xx, shape drift, or empty results — the
 * caller can't distinguish these, which is intentional (all mean "fall
 * through to LLM").
 */
export async function searchAuthors(name: string): Promise<OpenAlexAuthor[]> {
  const cacheKey = name.toLowerCase().trim();
  const cached = authorCache.get(cacheKey);
  if (cached !== undefined) return cached ?? [];

  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = fetchAuthorsOnce(name, cacheKey);
  inFlightRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

async function fetchAuthorsOnce(
  name: string,
  cacheKey: string,
): Promise<OpenAlexAuthor[]> {
  const url =
    `${OPENALEX_BASE}/authors?search=${encodeURIComponent(name)}` +
    `&per-page=${MAX_SEARCH_RESULTS}&select=${SELECT_FIELDS}`;

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
    // Guard against shape drift / HTML error pages disguised as 200.
    const results = Array.isArray(data?.results) ? data.results : [];
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

export interface PickAuthorResult {
  author: OpenAlexAuthor;
  /**
   * `unique` = only one OpenAlex author passed the name filter (could still
   * be a homonym — callers must not contradict on these). `disambiguated` =
   * multiple name matches, org context picked one (safe to contradict).
   */
  disambiguation: 'unique' | 'disambiguated';
}

/**
 * Disambiguate a candidate list to a single author using name + org context.
 * Returns null when no name match exists, or when multiple name matches
 * can't be uniquely resolved via org — caller should fall through to LLM.
 */
export function pickBestAuthor(
  candidates: OpenAlexAuthor[],
  targetName: string,
  targetOrg: string,
): PickAuthorResult | null {
  const nameMatched = candidates.filter((c) => nameMatches(targetName, c.display_name));
  if (nameMatched.length === 0) return null;
  if (nameMatched.length === 1) {
    return { author: nameMatched[0], disambiguation: 'unique' };
  }

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

  if (orgMatches.length === 1) {
    return { author: orgMatches[0], disambiguation: 'disambiguated' };
  }

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

  // Collect ALL affiliations matching the target org, not just the first.
  // OpenAlex commonly emits multiple affiliation rows per institution (one
  // per paper-year cluster), so an early-return on the first hit can miss
  // a later row with a year window that does cover the target.
  const orgMatches = affiliations.filter((a) =>
    nameMatches(targetOrg, a.institution.display_name),
  );

  if (orgMatches.length === 0) {
    // Target org is absent from all affiliations.
    return {
      matched: false,
      wrongOrg: true,
      wrongYear: false,
      actualInstitutions,
    };
  }

  // Use the first matched institution's display name for the result slot
  // (all org matches share the same institution by definition of nameMatches).
  const matchedInstitution = orgMatches[0].institution.display_name;

  // No target year supplied → any org match is a confirmation.
  if (targetYear == null) {
    return {
      matched: true,
      wrongOrg: false,
      wrongYear: false,
      matchedInstitution,
      actualInstitutions,
    };
  }

  // Check every org-matching affiliation against the target year.
  //
  // Rules:
  //   - If ANY row has years data covering the target (with slack) → matched.
  //   - If ANY row has empty years (no signal) → matched. The row exists as
  //     an org match, and we can't contradict a claim using a row that has
  //     no year information — it could be the correct current affiliation.
  //   - Only if EVERY row has year data and NONE of them cover the target
  //     do we flag wrongYear.
  let anyEmptyYears = false;
  for (const aff of orgMatches) {
    const years = aff.years ?? [];
    if (years.length === 0) {
      anyEmptyYears = true;
      continue;
    }
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    if (
      targetYear >= minYear - YEAR_SLACK_LOW &&
      targetYear <= maxYear + YEAR_SLACK_HIGH
    ) {
      return {
        matched: true,
        wrongOrg: false,
        wrongYear: false,
        matchedInstitution: aff.institution.display_name,
        actualInstitutions,
      };
    }
  }

  // No year-having row covered the target. If at least one row was missing
  // year data entirely, we can't confidently contradict — fall through to
  // matched (with no year signal). Otherwise, every row rejected the year.
  if (anyEmptyYears) {
    return {
      matched: true,
      wrongOrg: false,
      wrongYear: false,
      matchedInstitution,
      actualInstitutions,
    };
  }

  return {
    matched: false,
    wrongOrg: false,
    wrongYear: true,
    matchedInstitution,
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
    checkerModel: CHECKER_MODEL,
  };
}

/**
 * Try to verify a personnel record via OpenAlex. Returns null for any case
 * the matcher can't definitively decide (non-personnel, missing/unresolvable
 * names, no search results, ambiguous candidates, stub authors, or
 * single-name-match contradicted cases that could be a homonym).
 */
export async function tryOpenAlexMatch(item: VerifyItem): Promise<VerifyResult | null> {
  if (item.data.kind !== 'record') return null;
  const data = item.data as RecordItemData;
  if (data.recordType !== 'personnel') return null;

  const personName = data.fields.person;
  const orgName = data.fields.org;
  const startDate = data.fields.startDate;

  // `isResolvableName` rejects empty strings, the `(unknown)` sentinel, AND
  // `sid_*` stableIds — all of which would produce garbage OpenAlex queries.
  if (typeof personName !== 'string' || !isResolvableName(personName)) return null;
  if (typeof orgName !== 'string' || !isResolvableName(orgName)) return null;

  const rawCandidates = await searchAuthors(personName);
  if (rawCandidates.length === 0) return null;

  // Drop stub authors (`works_count === 0`) BEFORE disambiguation. Previously
  // this ran after `pickBestAuthor`, which could pick a stub over a legit
  // researcher when both name-matched.
  const candidates = rawCandidates.filter(
    (c) => (c.works_count ?? 0) >= MIN_WORKS_COUNT,
  );
  if (candidates.length === 0) return null;

  const pick = pickBestAuthor(candidates, personName, orgName);
  if (!pick) return null;
  const best = pick.author;

  const targetYear = extractYear(typeof startDate === 'string' ? startDate : null);
  const aff = checkAffiliation(best, orgName, targetYear);
  const shortId = shortOpenAlexId(best.id);

  // Preserve curated sourceUrl when set; surface the OpenAlex ID via reasoning.
  const sourceUrl = item.sourceUrl ?? best.id;
  const yearSuffix = targetYear != null ? ` (target year ${targetYear})` : '';

  if (aff.matched) {
    return makeResult(
      item,
      'confirmed',
      CONFIDENCE_CONFIRMED,
      `${best.display_name} → ${aff.matchedInstitution} (${shortId})`,
      `[openalex-api] OpenAlex ${shortId} (${best.display_name}) affiliated with ${aff.matchedInstitution}${yearSuffix}`,
      sourceUrl,
    );
  }

  // Homonym guard: a `unique` pick means there was only one OpenAlex author
  // with this name — we can't rule out that the personnel record references
  // a different same-named person absent from OpenAlex. Contradicting in
  // that case can overwrite curated evidence with a wrong verdict. Fall
  // through to the LLM instead. `disambiguated` picks already used org
  // context as a tiebreak, so contradicting them is safe.
  if ((aff.wrongYear || aff.wrongOrg) && pick.disambiguation === 'unique') {
    return null;
  }

  if (aff.wrongYear) {
    return makeResult(
      item,
      'contradicted',
      CONFIDENCE_CONTRADICTED,
      `${best.display_name} at ${aff.matchedInstitution} — year ${targetYear} outside affiliation window`,
      `[openalex-api] OpenAlex ${shortId} confirms ${best.display_name} at ${aff.matchedInstitution}, but the years on that affiliation do not cover target year ${targetYear} (slack -${YEAR_SLACK_LOW}/+${YEAR_SLACK_HIGH} applied)`,
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
      CONFIDENCE_CONTRADICTED,
      `${best.display_name} → ${actual}`,
      `[openalex-api] OpenAlex ${shortId} (${best.display_name}) affiliations [${actual}] do not include "${orgName}"`,
      sourceUrl,
    );
  }

  // Reached when the author exists but has no usable affiliation data.
  return makeResult(
    item,
    'unverifiable',
    CONFIDENCE_UNVERIFIABLE,
    '',
    `[openalex-api] OpenAlex ${shortId} (${best.display_name}) has no affiliation data`,
    sourceUrl,
  );
}
