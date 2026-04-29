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
import { normalizeUrlForJoin as normalizeUrl } from "./url-quality.ts";
import { subjectIdentityGate } from "./subject-identity-gate.ts";

/** Version tag for stored suggestions — bump when the generator changes shape. */
export const GENERATOR_MODEL = "qua-64/suggest-urls-v1";

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
  /**
   * Parent entity's Wikidata QID (e.g. "Q108542504"). When present, enables
   * the subject-identity gate (QUA-724): candidates whose URL points at a
   * different Wikidata entity are dropped with reason `subject-mismatch`
   * before they are persisted. Pass `null` / omit to disable the gate
   * (fail-open default — matches today's behaviour for entities without a
   * known QID).
   */
  entityWikidataQid?: string | null;
}

export type SuggestUrlsProvider = 'manual' | 'exa' | 'perplexity' | 'scry';

export interface UrlSuggestion {
  url: string;
  title: string;
  snippet: string | null;
  relevanceScore: number | null;
  sourceProvider: SuggestUrlsProvider;
}

export interface SuggestUrlsResult {
  candidates: UrlSuggestion[];
  providersUsed: string[];
  providersSkipped: string[];
  query: string;
  /** Approximate USD cost (currently only Perplexity reports cost). */
  costUsd: number;
  /**
   * Candidates dropped by the subject-identity gate (QUA-724). Empty when
   * the gate is disabled (no `entityWikidataQid` supplied) or when no
   * candidate had an extractable Wikidata QID. Each entry records the
   * dropped URL, the offending QID, and the entity QID so callers can log
   * for observability without re-running the gate.
   */
  subjectMismatches: Array<{
    url: string;
    candidateQid: string;
    entityQid: string;
  }>;
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
  // Strip quotes and newlines from untrusted inputs so they can't break Exa's
  // quote-wrapping or the JSON prompts sent to Perplexity.
  const sanitize = (s: string) =>
    s.replace(/["\r\n]/g, " ").replace(/\s+/g, " ").trim();

  const entity = sanitize(opts.entityName);
  const field = opts.fieldName ? sanitize(opts.fieldName.replace(/_/g, " ")) : "";
  const claim = sanitize(opts.claimText);
  const trimmedClaim = claim.length > 160 ? `${claim.slice(0, 157)}...` : claim;

  return [`"${entity}"`, field, trimmedClaim]
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
}

/**
 * Stable dedupe by normalized URL, preserving provider insertion order.
 * First hit wins on dedupe collisions.
 *
 * Pass `excludeKey` (a normalized URL) to skip a known URL — lets callers
 * filter out the existing source in the same pass instead of a separate
 * filter that would re-normalize every hit.
 */
function dedupeHits(
  hits: SearchHit[],
  maxCandidates: number,
  excludeKey: string | null,
): SearchHit[] {
  const seen = new Set<string>();
  if (excludeKey) seen.add(excludeKey);
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
 * Run web search and return 1-3 candidate URLs. Returns `candidates: []` if
 * no API keys are configured or all providers fail.
 */
export async function suggestUrls(input: SuggestUrlsInput): Promise<SuggestUrlsResult> {
  const {
    entityName, claimText, fieldName, existingUrl,
    maxCandidates = 3, useExa = true, usePerplexity = true,
    entityWikidataQid = null,
  } = input;

  const query = buildSearchQuery({ entityName, claimText, fieldName });
  // Request 2x max so dedup + existing-url filter still leave enough candidates.
  const perProvider = Math.max(maxCandidates * 2, 4);

  // `used` tracks successful providers; `skipped` covers missing-key and failed
  // calls. A failed attempt appears only in `skipped`, never in both.
  const providersUsed: string[] = [];
  const providersSkipped: string[] = [];
  let costUsd = 0;

  const runProvider = async (
    name: string,
    enabled: boolean,
    apiKey: string,
    fetch: () => Promise<{ hits: SearchHit[]; cost?: number }>,
  ): Promise<SearchHit[]> => {
    if (!enabled) return [];
    if (!getApiKey(apiKey)) {
      providersSkipped.push(`${name}:no-key`);
      return [];
    }
    try {
      const { hits, cost } = await fetch();
      providersUsed.push(name);
      costUsd += cost ?? 0;
      return hits;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      providersSkipped.push(`${name}:${msg.slice(0, 120)}`);
      return [];
    }
  };

  const allHits = (
    await Promise.all([
      runProvider("exa", useExa, "EXA_API_KEY", async () => ({
        hits: await searchExa(query, perProvider),
      })),
      runProvider("perplexity", usePerplexity, "OPENROUTER_API_KEY", () =>
        searchPerplexity(query, perProvider),
      ),
    ])
  ).flat();

  const excludeKey = existingUrl ? normalizeUrl(existingUrl) : null;
  // Dedupe + cap first, then apply the subject-identity gate (QUA-724).
  // The gate may shrink the result below `maxCandidates`; we don't backfill
  // here because the wider pipeline (QUA-722) is the right place to ask the
  // search providers for more if too many were dropped.
  const dedupedHits = dedupeHits(allHits, maxCandidates, excludeKey);

  const gateResult = subjectIdentityGate({
    entityQid: entityWikidataQid,
    candidates: dedupedHits.map((hit) => ({ url: hit.url, _hit: hit })),
  });

  const candidates: UrlSuggestion[] = gateResult.kept.map((c) => {
    const hit = c._hit;
    return {
      url: hit.url,
      title: hit.title,
      snippet: hit.snippet ?? null,
      relevanceScore: null, // No cross-provider score model yet.
      sourceProvider: hit.provider as SuggestUrlsProvider,
    };
  });

  const subjectMismatches = gateResult.dropped.map((d) => ({
    url: d.candidate.url,
    candidateQid: d.candidateQid,
    entityQid: d.entityQid,
  }));

  return {
    candidates,
    providersUsed,
    providersSkipped,
    query,
    costUsd,
    subjectMismatches,
  };
}
