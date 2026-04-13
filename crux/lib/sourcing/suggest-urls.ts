/**
 * URL suggestion generator — QUA-64.
 *
 * Given a record whose sourcing verdict is `unverifiable`, search the web
 * for candidate URLs that might actually contain the claim.
 *
 * Pipeline:
 *   1. Build a search query from (entityName, claimText, fieldName)
 *   2. Search Exa + Perplexity in parallel
 *   3. Dedupe URLs (same URL from multiple providers → keep highest-ranked)
 *   4. Filter out the existing source URL (that's the one that failed)
 *   5. Return top N candidates ranked by provider-order + result order
 *
 * Caller (CLI or worker) is responsible for persisting via
 * POST /api/sourcing/url-suggestions.
 */

import {
  searchExa,
  searchPerplexity,
  type SearchHit,
} from "../search/research-agent.ts";
import { getApiKey } from "../api-keys.ts";

export interface SuggestUrlsInput {
  /** Display name of the parent entity (e.g. "Anthropic"). */
  entityName: string;
  /** What the record claims (e.g. "Anthropic had 500 employees in 2024"). */
  claimText: string;
  /** Field being checked (e.g. "employee_count"), optional. */
  fieldName?: string | null;
  /** The current source URL that came back unverifiable — excluded from results. */
  existingUrl?: string | null;
  /** Max candidates to return (default 3). */
  maxCandidates?: number;
  /** Provider toggles (auto-disabled when the key is missing). */
  useExa?: boolean;
  usePerplexity?: boolean;
}

export interface UrlSuggestion {
  url: string;
  title: string;
  snippet: string | null;
  relevanceScore: number | null;
  sourceProvider: string;
}

export interface SuggestUrlsResult {
  candidates: UrlSuggestion[];
  providersUsed: string[];
  providersSkipped: string[];
  query: string;
  /** Approximate USD cost (currently only Perplexity reports cost). */
  costUsd: number;
}

// ---------------------------------------------------------------------------

/**
 * Build a focused search query from record context.
 *
 * Keeps the query short and quote-wrapped where it helps, without over-constraining.
 */
export function buildSearchQuery(opts: {
  entityName: string;
  claimText: string;
  fieldName?: string | null;
}): string {
  const { entityName, claimText, fieldName } = opts;

  // Shorter claims go verbatim; longer ones get truncated so query stays tight.
  const trimmedClaim = claimText.length > 160 ? `${claimText.slice(0, 157)}...` : claimText;

  const parts: string[] = [];
  parts.push(`"${entityName}"`);
  if (fieldName) parts.push(fieldName.replace(/_/g, " "));
  parts.push(trimmedClaim);

  return parts.join(" ").slice(0, 300);
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Drop trailing slash, fragment, and common tracking params.
    u.hash = "";
    const stripParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "ref",
      "ref_src",
    ];
    for (const p of stripParams) u.searchParams.delete(p);
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

function rankHits(hits: SearchHit[], maxCandidates: number): SearchHit[] {
  // Simple ranking: stable dedupe, preserve provider insertion order.
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...hit, url: key });
    if (out.length >= maxCandidates) break;
  }
  return out;
}

/**
 * Run web search and return 1-3 candidate URLs. Returns `candidates: []` if no
 * provider API keys are configured or all providers fail.
 */
export async function suggestUrls(
  input: SuggestUrlsInput
): Promise<SuggestUrlsResult> {
  const {
    entityName,
    claimText,
    fieldName,
    existingUrl,
    maxCandidates = 3,
    useExa = true,
    usePerplexity = true,
  } = input;

  const query = buildSearchQuery({ entityName, claimText, fieldName });
  const providersUsed: string[] = [];
  const providersSkipped: string[] = [];
  let costUsd = 0;

  // Request 2x max so after dedup + existing-url filter we can still return maxCandidates.
  const perProvider = Math.max(maxCandidates * 2, 4);

  const tasks: Promise<SearchHit[]>[] = [];

  if (useExa && getApiKey("EXA_API_KEY")) {
    providersUsed.push("exa");
    tasks.push(
      searchExa(query, perProvider).catch((err: unknown) => {
        providersSkipped.push(`exa:${errorMessage(err)}`);
        return [] as SearchHit[];
      })
    );
  } else if (useExa) {
    providersSkipped.push("exa:no-key");
  }

  if (usePerplexity && getApiKey("OPENROUTER_API_KEY")) {
    providersUsed.push("perplexity");
    tasks.push(
      searchPerplexity(query, perProvider)
        .then((r) => {
          costUsd += r.cost;
          return r.hits;
        })
        .catch((err: unknown) => {
          providersSkipped.push(`perplexity:${errorMessage(err)}`);
          return [] as SearchHit[];
        })
    );
  } else if (usePerplexity) {
    providersSkipped.push("perplexity:no-key");
  }

  const results = await Promise.all(tasks);
  const allHits = results.flat();

  // Filter out the existing (unverifiable) URL so we don't re-suggest it.
  const existingKey = existingUrl ? normalizeUrl(existingUrl) : null;
  const filtered = existingKey
    ? allHits.filter((h) => normalizeUrl(h.url) !== existingKey)
    : allHits;

  const ranked = rankHits(filtered, maxCandidates);

  const candidates: UrlSuggestion[] = ranked.map((hit) => ({
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet ?? null,
    // No cross-provider score model yet — leave null. Can be added later.
    relevanceScore: null,
    sourceProvider: hit.provider,
  }));

  return { candidates, providersUsed, providersSkipped, query, costUsd };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 120);
  return String(err).slice(0, 120);
}
