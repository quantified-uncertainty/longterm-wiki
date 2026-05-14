/**
 * Top-level "process one record" pipeline.
 *
 * Reads at the same level as the pseudocode:
 *   query   = build_search_query(record)
 *   sources = run_research(query)
 *   matches = verify(sources, record)
 *   chosen  = matches[0] if len==1 else rank(matches)
 *   write_source(record, chosen.url) when --apply
 */

import { runResearch } from '../search/research-agent.ts';
import { buildSearchQuery } from './build-search-query.ts';
import { PER_RECORD_BUDGET, SELF_DOMAINS } from './config.ts';
import { addCost, emptyCost } from './cost.ts';
import { entitiesToMention, isSelfDomain } from './entity-mention.ts';
import { humanizeClaim } from './humanize-claim.ts';
import { rankMatchingSources } from './llm-calls.ts';
import { extractMatchTerms } from './match-terms.ts';
import { verifySource } from './verify-source.ts';
import type { RejectionReason, VerifyResult } from './verify-source.ts';
import type {
  CandidateRecord,
  CostBreakdown,
  MissingSourceRecord,
  RankCandidate,
} from './types.ts';

export interface ProcessOptions {
  dryRun: boolean;
  apply: boolean;
  debug?: boolean;
}

export type ProcessResult =
  | {
      matched: true;
      url: string;
      provider?: string;
      quotes?: string[];
      cost: CostBreakdown;
      candidates: CandidateRecord[];
    }
  | { matched: false; reason: string; cost: CostBreakdown; candidates: CandidateRecord[] };

/**
 * Run the full pipeline for one record. Caller is responsible for the actual
 * DB write — this returns the chosen URL on success, leaving persistence to
 * the orchestrator (which knows whether --apply is set and counts updates).
 */
export async function processRecord(
  record: MissingSourceRecord,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const cost = emptyCost();

  // Short-circuit: when a fact's value is itself an http(s) URL (e.g.
  // `Google Scholar = https://scholar.google.com/...`, `Website = https://...`),
  // the value IS the citation — no web search needed. Free, no LLM calls,
  // perfect precision.
  const selfSource = selfSourcingUrl(record);
  if (selfSource) {
    console.log(`  ✓ Self-sourced (value is a URL): ${selfSource}`);
    return {
      matched: true,
      url: selfSource,
      provider: 'self-sourced',
      cost,
      candidates: [],
    };
  }

  const entityName = (record.entity_name ?? '').trim();
  const matchTerms = extractMatchTerms(record);
  const claim = humanizeClaim(record) || matchTerms[0] || '';
  const mentionTargets = entitiesToMention(record);

  const sources = await fetchCandidateSources(record, cost);
  if (sources === null) {
    return { matched: false, reason: 'search failed', cost, candidates: [] };
  }

  const matches = await verifyAllSources(sources, claim, entityName, mentionTargets, cost, options);

  if (matches.accepted.length === 0) {
    return {
      matched: false,
      reason: matches.rejectionSummary,
      cost,
      candidates: matches.candidates,
    };
  }

  const chosen = await pickBestMatch(matches.accepted, record, matchTerms, cost);
  console.log(matches.accepted.length === 1
    ? `  ✓ Match: ${chosen.url}`
    : `  ✓ Best of ${matches.accepted.length} matches: ${chosen.url}`);

  return {
    matched: true,
    url: chosen.url,
    provider: chosen.provider,
    quotes: chosen.quotes,
    cost,
    candidates: matches.candidates,
  };
}

// ---------------------------------------------------------------------------
// Step 1: build a search query and run the research agent
// ---------------------------------------------------------------------------

async function fetchCandidateSources(
  record: MissingSourceRecord,
  cost: CostBreakdown,
): Promise<{ url: string; content: string; title?: string; provider?: string }[] | null> {
  const entityName = (record.entity_name ?? '').trim();
  const searchQuery = buildSearchQuery(record);

  try {
    const research = await runResearch({
      topic: searchQuery,
      // Drop self-domain URLs before fetch — verifySource would reject
      // them anyway, but fetching wastes Playwright + Wayback time.
      excludeHosts: SELF_DOMAINS,
      pageContext: { title: entityName, type: 'unknown' },
      config: {
        maxResultsPerSource: 3,
        maxUrlsToFetch: 5,
        extractFacts: false,
        useGitHub: false,
        useSemanticScholar: false,
        useFederalRegister: false,
      },
      budgetCap: PER_RECORD_BUDGET,
    });
    cost.searchCost = research.metadata.costBreakdown.searchCost;
    cost.factExtractionCost = research.metadata.costBreakdown.factExtractionCost;
    return research.sources;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Search failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: verify each source, accumulate accepted candidates + rejection counts
// ---------------------------------------------------------------------------

interface VerifyAllResult {
  accepted: RankCandidate[];
  rejectionSummary: string;
  candidates: CandidateRecord[];
}

async function verifyAllSources(
  sources: { url: string; content: string; title?: string; provider?: string }[],
  claim: string,
  entityName: string,
  mentionTargets: string[][],
  cost: CostBreakdown,
  options: ProcessOptions,
): Promise<VerifyAllResult> {
  const accepted: RankCandidate[] = [];
  const candidates: CandidateRecord[] = [];
  const rejectionCounts: Partial<Record<RejectionReason, number>> = {};

  for (const source of sources) {
    const result = await verifySource(source, claim, entityName, mentionTargets);
    cost.quoteExtractCost += result.cost.quoteExtractCost;
    cost.entailmentCost += result.cost.entailmentCost;
    candidates.push(result.record);

    if (options.debug) logVerifyResult(source.url, result);

    if (result.kind === 'accepted') {
      accepted.push(result.candidate);
    } else {
      rejectionCounts[result.reason] = (rejectionCounts[result.reason] ?? 0) + 1;
    }
  }

  return {
    accepted,
    rejectionSummary: summarizeRejections(rejectionCounts),
    candidates,
  };
}

const REJECTION_LABELS: Record<RejectionReason, string> = {
  'invalid-url': 'invalid URL',
  'self-domain': 'self domain',
  'placeholder-url': 'placeholder URL',
  'too-short': 'content too short',
  'no-entity-mention': 'no entity mention',
  'no-quote': 'no supporting quote',
  'quote-fabricated': 'fabricated quote',
  'entailment-failed': 'entailment failed',
};

/**
 * Build the human-readable rejection summary that goes into the no-match
 * outcome reason. Drops `self-domain` and `too-short` since those are
 * structural skips (not content failures) and would clutter the report.
 */
function summarizeRejections(counts: Partial<Record<RejectionReason, number>>): string {
  const reportable: RejectionReason[] = ['placeholder-url', 'no-entity-mention', 'no-quote', 'quote-fabricated', 'entailment-failed'];
  const parts = reportable
    .filter(r => (counts[r] ?? 0) > 0)
    .map(r => `${counts[r]} ${REJECTION_LABELS[r]}`);
  return parts.length > 0
    ? `no candidate passed verification (${parts.join(', ')})`
    : 'no candidate passed verification';
}

function logVerifyResult(url: string, result: VerifyResult): void {
  if (result.kind === 'accepted') {
    console.log(`    [accepted] ${url}`);
    for (const q of result.candidate.quotes ?? []) {
      console.log(`        Quote: "${q.slice(0, 200)}"`);
    }
    return;
  }
  switch (result.reason) {
    case 'self-domain':
      console.log(`    [self-domain] ${url}`);
      break;
    case 'placeholder-url':
      console.log(`    [placeholder-url] ${url}`);
      break;
    case 'too-short':
      console.log(`    [too-short] ${url}`);
      break;
    case 'no-entity-mention':
      console.log(`    [no-entity-mention missing=${JSON.stringify(result.detail?.missingSlots ?? [])}] ${url}`);
      break;
    case 'no-quote':
      console.log(`    [no-quote] ${url}`);
      break;
    case 'quote-fabricated':
      console.log(`    [all-quotes-fabricated] ${url}`);
      for (const q of result.detail?.haikuQuotes ?? []) {
        console.log(`        Haiku said: "${q.slice(0, 200)}"`);
      }
      break;
    case 'entailment-failed':
      console.log(`    [entailment-failed] ${url}`);
      for (const q of result.detail?.verifiedQuotes ?? []) {
        console.log(`        Quote: "${q.slice(0, 200)}"`);
      }
      console.log(`        Sonnet said: doesn't entail claim`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Step 3: pick the single best match (Haiku ranking when there are >1)
// ---------------------------------------------------------------------------

async function pickBestMatch(
  candidates: RankCandidate[],
  record: MissingSourceRecord,
  matchTerms: string[],
  cost: CostBreakdown,
): Promise<RankCandidate> {
  if (candidates.length === 1) return candidates[0];

  // Ranking uses the raw description (it carries field/value detail Haiku
  // benefits from), falling back to the first match term when description is
  // empty.
  const rankClaim = (record.description || matchTerms[0] || '').trim();
  const entityName = (record.entity_name ?? '').trim();
  const result = await rankMatchingSources(rankClaim, entityName, candidates);

  const rankCost = emptyCost();
  rankCost.rankCost = result.cost;
  addCost(cost, rankCost);

  return candidates[result.index];
}

// ---------------------------------------------------------------------------
// Helper: detect facts whose `value` IS the source
// ---------------------------------------------------------------------------

/**
 * Returns the URL to use as the source when a fact's `value` is itself an
 * http(s) URL (the value IS the citation), or null when the record isn't
 * self-sourcing. Only applies to the `facts` table — other tables (personnel,
 * investments, etc.) don't have a free-form `value` column with this shape.
 *
 * Strict scheme + no embedded whitespace: "see https://x for details" is text
 * with a URL embedded, not a URL value, and shouldn't trigger self-sourcing.
 */
export function selfSourcingUrl(record: MissingSourceRecord): string | null {
  if (record.record_table !== 'facts') return null;
  const value = record.value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  if (isSelfDomain(trimmed)) return null;
  return trimmed;
}
