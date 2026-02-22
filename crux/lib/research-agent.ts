/**
 * Research Agent — Multi-source search to structured SourceCacheEntry[]
 *
 * Sits between the source-fetcher (raw URL fetch) and the section-writer /
 * citation-auditor (which consume SourceCacheEntry[]).
 *
 * Pipeline:
 *   1. Accept a topic / query (+ optional page context)
 *   2. Run multi-source search: Exa, Perplexity/Sonar, SCRY
 *      — each source runs only if its API key is present; degrades gracefully
 *   3. Deduplicate URLs from multiple providers (fetch once, merge metadata)
 *   4. Fetch each URL via source-fetcher.fetchSource()
 *   5. Extract 1-sentence structured facts with Haiku (cheap call per source)
 *   6. Return SourceCacheEntry[] ready for section-writer + research metadata
 *
 * Usage:
 *   import { runResearch } from './research-agent.ts';
 *
 *   const result = await runResearch({
 *     topic: 'Anthropic constitutional AI',
 *     pageContext: { title: 'Anthropic', type: 'organization', entityId: 'anthropic' },
 *     budgetCap: 3.00,
 *   });
 *   // result.sources — SourceCacheEntry[] for section-writer
 *   // result.metadata — cost, sources searched, timing
 *
 * See issue #684.
 */

import { getApiKey } from './api-keys.ts';
import { fetchSources } from './source-fetcher.ts';
import { createLlmClient, streamingCreate, extractText, MODELS } from './llm.ts';
import type { SourceCacheEntry } from './section-writer.ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Optional page context to focus research queries. */
export interface ResearchPageContext {
  /** Page title, e.g. "Anthropic". */
  title: string;
  /** Entity type, e.g. 'organization'. */
  type: string;
  /** Optional entity ID from data/entities, e.g. 'anthropic'. */
  entityId?: string;
}

/** Which search providers to use and how many results to request. */
export interface ResearchConfig {
  /** Use Exa web search (default: true if EXA_API_KEY is set). */
  useExa?: boolean;
  /** Use Perplexity via OpenRouter (default: true if OPENROUTER_API_KEY is set). */
  usePerplexity?: boolean;
  /** Use SCRY EA Forum / LessWrong search (default: true if SCRY_API_KEY is set, or public key). */
  useScry?: boolean;
  /** Max URLs to collect from each search provider (default: 8). */
  maxResultsPerSource?: number;
  /** Max URLs to actually fetch (after dedup, default: 20). */
  maxUrlsToFetch?: number;
  /** Extract structured facts from each fetched source (default: true). */
  extractFacts?: boolean;
  /** Number of facts to extract per source (default: 5). */
  factsPerSource?: number;
}

/** Input to the research agent. */
export interface ResearchRequest {
  /** Main topic string, e.g. "Anthropic constitutional AI safety". */
  topic: string;
  /** Alternative search query if different from topic (e.g. more specific). */
  query?: string;
  /** Optional page context to narrow research focus. */
  pageContext?: ResearchPageContext;
  /** Search provider configuration. */
  config?: ResearchConfig;
  /** Hard budget cap in USD — stops searching/fetching when exceeded (default: 5.00). */
  budgetCap?: number;
}

/** Cost breakdown for the research run. */
export interface ResearchCostBreakdown {
  /** Cost from Perplexity search queries (USD). */
  searchCost: number;
  /** Cost from Haiku fact-extraction calls (USD). */
  factExtractionCost: number;
}

/** Result of a research run. */
export interface ResearchResult {
  /** Structured sources ready for section-writer. */
  sources: SourceCacheEntry[];
  /** Metadata about the research run. */
  metadata: {
    /** Which providers were searched (e.g. ['exa', 'perplexity', 'scry']). */
    sourcesSearched: string[];
    /** Total unique URLs discovered across all providers. */
    urlsFound: number;
    /** URLs actually fetched (may be less than urlsFound due to budget cap). */
    urlsFetched: number;
    /** URLs that appeared in multiple providers and were deduplicated. */
    urlsDeduplicated: number;
    /** Total USD cost (search + LLM calls). */
    totalCost: number;
    costBreakdown: ResearchCostBreakdown;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  provider: string;
}

interface ExaResult {
  title: string;
  url: string;
  publishedDate?: string;
  text?: string;
}

interface ExaResponse {
  results: ExaResult[];
}

interface ScryRow {
  title: string;
  uri: string;
  snippet?: string;
}

interface ScryApiResponse {
  rows?: ScryRow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRY_PUBLIC_KEY = 'exopriors_public_readonly_v1_2025';
const DEFAULT_BUDGET_CAP = 5.0;
const DEFAULT_MAX_RESULTS_PER_SOURCE = 8;
const DEFAULT_MAX_URLS_TO_FETCH = 20;
const DEFAULT_FACTS_PER_SOURCE = 5;

/** Haiku pricing per million tokens (USD). */
const HAIKU_INPUT_COST_PER_M = 0.80;
const HAIKU_OUTPUT_COST_PER_M = 4.00;

// ---------------------------------------------------------------------------
// Exa search
// ---------------------------------------------------------------------------

async function searchExa(query: string, maxResults: number): Promise<SearchHit[]> {
  const apiKey = getApiKey('EXA_API_KEY');
  if (!apiKey) throw new Error('EXA_API_KEY not set');

  const body = {
    query,
    type: 'auto',
    numResults: maxResults,
    contents: { text: { maxCharacters: 400 } },
  };

  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Exa API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as ExaResponse;
  return (data.results || [])
    .filter(r => r.title && r.url)
    .map(r => ({
      url: r.url,
      title: r.title,
      snippet: r.text?.slice(0, 400),
      provider: 'exa',
    }));
}

// ---------------------------------------------------------------------------
// Perplexity search via OpenRouter
// ---------------------------------------------------------------------------

interface PerplexityApiResponse {
  choices?: Array<{ message: { content: string } }>;
  citations?: string[];
  usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function searchPerplexity(
  query: string,
  maxResults: number,
): Promise<{ hits: SearchHit[]; cost: number }> {
  const apiKey = getApiKey('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const systemPrompt = `You are a research assistant. Find URLs and titles of ${maxResults} highly relevant sources for the given query. Focus on authoritative, credible sources. Return ONLY a JSON array with objects having "url" and "title" fields — no prose, no markdown.`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://www.longtermwiki.com',
      'X-Title': 'LongtermWiki Research Agent',
    },
    body: JSON.stringify({
      model: 'perplexity/sonar',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await response.json() as PerplexityApiResponse;

  if (!response.ok || data.error) {
    const msg = data.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Perplexity/OpenRouter error: ${msg}`);
  }

  const cost = data.usage?.cost ?? 0;

  // Extract citation URLs from Perplexity response
  const citations = data.citations ?? [];
  const content = data.choices?.[0]?.message?.content ?? '';

  // Prefer structured JSON if the model returned it; fall back to citations list
  let hits: SearchHit[] = [];
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ url?: string; title?: string }>;
      hits = parsed
        .filter(item => item.url && item.title)
        .slice(0, maxResults)
        .map(item => ({
          url: item.url!,
          title: item.title!,
          snippet: undefined,
          provider: 'perplexity',
        }));
    }
  } catch {
    // Fall through to citations
  }

  // Supplement with raw citation URLs if JSON parse failed or gave few results
  if (hits.length < maxResults && citations.length > 0) {
    const existingUrls = new Set(hits.map(h => h.url));
    for (const url of citations.slice(0, maxResults)) {
      if (!existingUrls.has(url)) {
        hits.push({ url, title: url, provider: 'perplexity' });
        existingUrls.add(url);
      }
      if (hits.length >= maxResults) break;
    }
  }

  return { hits, cost };
}

// ---------------------------------------------------------------------------
// SCRY search (EA Forum + LessWrong)
// ---------------------------------------------------------------------------

const VALID_SCRY_TABLES = ['mv_eaforum_posts', 'mv_lesswrong_posts'] as const;

async function searchScry(query: string, maxResults: number): Promise<SearchHit[]> {
  const apiKey = getApiKey('SCRY_API_KEY') ?? SCRY_PUBLIC_KEY;

  const tables = VALID_SCRY_TABLES;
  const allHits: SearchHit[] = [];
  const seenUrls = new Set<string>();
  const perTable = Math.ceil(maxResults / tables.length);

  for (const table of tables) {
    try {
      const sql = `SELECT title, uri, snippet FROM scry.search('${query.replace(/'/g, "''")}', '${table}') WHERE title IS NOT NULL AND kind = 'post' LIMIT ${perTable}`;

      const response = await fetch('https://api.exopriors.com/v1/scry/query', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'text/plain',
        },
        body: sql,
        signal: AbortSignal.timeout(15_000),
      });

      const data = await response.json() as ScryApiResponse;

      for (const row of data.rows ?? []) {
        if (row.title && row.uri && !seenUrls.has(row.uri)) {
          seenUrls.add(row.uri);
          allHits.push({
            url: row.uri,
            title: row.title,
            snippet: row.snippet,
            provider: 'scry',
          });
        }
      }
    } catch {
      // One table failing shouldn't abort the other
    }
  }

  return allHits.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Fact extraction via Haiku
// ---------------------------------------------------------------------------

interface FactExtractionResult {
  facts: string[];
  cost: number;
}

let _llmClient: ReturnType<typeof createLlmClient> | null = null;
function getLlmClient() {
  if (!_llmClient) _llmClient = createLlmClient();
  return _llmClient;
}

async function extractFacts(
  content: string,
  query: string,
  factsPerSource: number,
): Promise<FactExtractionResult> {
  if (!content.trim()) return { facts: [], cost: 0 };

  const excerpt = content.slice(0, 6_000);

  const prompt = `Extract ${factsPerSource} key facts from this source relevant to the query: "${query}".

Source content:
${excerpt}

Rules:
- Each fact must be a single clear sentence (≤25 words).
- Only include facts that are explicitly stated in the source.
- Prefer concrete, specific facts (numbers, dates, names, claims) over general statements.
- Return ONLY a JSON array of strings, e.g. ["Fact 1.", "Fact 2."]
- No preamble, no markdown.`;

  let raw: string;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await streamingCreate(getLlmClient(), {
      model: MODELS.haiku,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = extractText(response);
    inputTokens = response.usage?.input_tokens ?? 0;
    outputTokens = response.usage?.output_tokens ?? 0;
  } catch {
    return { facts: [], cost: 0 };
  }

  const cost =
    (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;

  let facts: string[] = [];
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        facts = parsed
          .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
          .slice(0, factsPerSource);
      }
    }
  } catch {
    // If parsing fails, extract lines that look like facts
    facts = raw
      .split('\n')
      .map(l => l.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter(l => l.length > 10 && l.length < 200)
      .slice(0, factsPerSource);
  }

  return { facts, cost };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Run multi-source research for a topic, producing SourceCacheEntry[] for
 * the section-writer pipeline.
 *
 * All search providers degrade gracefully: if a key is missing or a provider
 * times out, the agent continues with whatever data it has.
 */
export async function runResearch(request: ResearchRequest): Promise<ResearchResult> {
  const startMs = Date.now();

  const {
    topic,
    query = topic,
    pageContext,
    config = {},
    budgetCap = DEFAULT_BUDGET_CAP,
  } = request;

  const {
    useExa = !!getApiKey('EXA_API_KEY'),
    usePerplexity = !!getApiKey('OPENROUTER_API_KEY'),
    useScry = true,
    maxResultsPerSource = DEFAULT_MAX_RESULTS_PER_SOURCE,
    maxUrlsToFetch = DEFAULT_MAX_URLS_TO_FETCH,
    extractFacts: shouldExtractFacts = true,
    factsPerSource = DEFAULT_FACTS_PER_SOURCE,
  } = config;

  // Focus query with page context if provided
  const focusedQuery = pageContext
    ? `${query} ${pageContext.title} ${pageContext.type}`
    : query;

  let totalCost = 0;
  let searchCost = 0;
  let factExtractionCost = 0;
  const sourcesSearched: string[] = [];

  // -------------------------------------------------------------------------
  // Phase 1: Multi-source search (run providers in parallel)
  // -------------------------------------------------------------------------

  const searchPromises: Array<Promise<SearchHit[]>> = [];
  const providerNames: string[] = [];

  if (useExa) {
    providerNames.push('exa');
    searchPromises.push(
      searchExa(focusedQuery, maxResultsPerSource).catch(err => {
        console.warn(`[research-agent] Exa search failed: ${err instanceof Error ? err.message : err}`);
        return [];
      }),
    );
  }

  if (usePerplexity) {
    providerNames.push('perplexity');
    searchPromises.push(
      searchPerplexity(focusedQuery, maxResultsPerSource).then(r => {
        searchCost += r.cost;
        totalCost += r.cost;
        return r.hits;
      }).catch(err => {
        console.warn(`[research-agent] Perplexity search failed: ${err instanceof Error ? err.message : err}`);
        return [];
      }),
    );
  }

  if (useScry) {
    providerNames.push('scry');
    searchPromises.push(
      searchScry(focusedQuery, maxResultsPerSource).catch(err => {
        console.warn(`[research-agent] SCRY search failed: ${err instanceof Error ? err.message : err}`);
        return [];
      }),
    );
  }

  const allHitArrays = await Promise.all(searchPromises);

  // Track which providers returned at least one result
  for (let i = 0; i < providerNames.length; i++) {
    if (allHitArrays[i].length > 0) {
      sourcesSearched.push(providerNames[i]);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Deduplicate URLs
  // -------------------------------------------------------------------------

  const urlToHits = new Map<string, SearchHit[]>();

  for (const hits of allHitArrays) {
    for (const hit of hits) {
      // Normalize URL: strip trailing slash
      const normalized = hit.url.replace(/\/$/, '');
      const existing = urlToHits.get(normalized) ?? [];
      existing.push(hit);
      urlToHits.set(normalized, existing);
    }
  }

  const urlsFound = urlToHits.size;
  const urlsDeduplicated = allHitArrays.reduce((sum, arr) => sum + arr.length, 0) - urlsFound;

  // Build a best-title mapping from all hits for each URL
  const urlBestTitle = new Map<string, string>();
  for (const [url, hits] of urlToHits) {
    // Prefer the hit with a non-URL title
    const best = hits.find(h => h.title !== h.url) ?? hits[0];
    urlBestTitle.set(url, best.title);
  }

  // -------------------------------------------------------------------------
  // Phase 3: Budget-aware URL fetching
  // -------------------------------------------------------------------------

  const urlsToFetch = [...urlToHits.keys()].slice(0, maxUrlsToFetch);
  const urlsFetched = urlsToFetch.length;

  const fetchRequests = urlsToFetch.map(url => ({
    url,
    extractMode: 'relevant' as const,
    query: focusedQuery,
  }));

  const fetchedSources = await fetchSources(fetchRequests, { concurrency: 5, delayMs: 200 });

  // -------------------------------------------------------------------------
  // Phase 4: Fact extraction (Haiku call per fetched source)
  // -------------------------------------------------------------------------

  const sources: SourceCacheEntry[] = [];

  for (let i = 0; i < fetchedSources.length; i++) {
    const fetched = fetchedSources[i];
    const url = urlsToFetch[i];
    const title = fetched.title || (urlBestTitle.get(url) ?? url);

    if (totalCost >= budgetCap) {
      // Budget exhausted — still add the source but skip fact extraction
      sources.push({
        id: `SRC-${i + 1}`,
        url: fetched.url,
        title,
        content: fetched.relevantExcerpts.join('\n\n') || fetched.content.slice(0, 3_000),
        facts: [],
      });
      continue;
    }

    let facts: string[] = [];

    if (shouldExtractFacts && fetched.status === 'ok' && fetched.content) {
      const extractionResult = await extractFacts(
        fetched.content,
        focusedQuery,
        factsPerSource,
      );
      facts = extractionResult.facts;
      factExtractionCost += extractionResult.cost;
      totalCost += extractionResult.cost;
    }

    sources.push({
      id: `SRC-${i + 1}`,
      url: fetched.url,
      title,
      content: fetched.relevantExcerpts.join('\n\n') || fetched.content.slice(0, 3_000),
      facts: facts.length > 0 ? facts : undefined,
    });
  }

  const durationMs = Date.now() - startMs;

  return {
    sources,
    metadata: {
      sourcesSearched,
      urlsFound,
      urlsFetched,
      urlsDeduplicated,
      totalCost,
      costBreakdown: {
        searchCost,
        factExtractionCost,
      },
      durationMs,
    },
  };
}
