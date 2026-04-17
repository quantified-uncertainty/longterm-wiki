/**
 * Research Phase
 *
 * Conducts web and SCRY searches to gather sources for page improvement.
 * After LLM-based search, fetches discovered URLs through the source-fetcher
 * to build a grounded source cache for downstream modules (#668).
 */

import { z } from 'zod';
import { MODELS } from '../../../lib/anthropic.ts';
import { fetchSources, type FetchRequest, type FetchedSource } from '../../../lib/search/source-fetcher.ts';
import { MIN_SOURCE_CONTENT_LENGTH } from '../../../lib/citation/citation-service.ts';
import type { SourceCacheEntry } from '../../../lib/content/section-writer.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../types.ts';
import { log, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { parseAndValidate, ResearchResultSchema } from './json-parsing.ts';
import { loadPlaybook, formatPlaybookForPrompt } from '../../../lib/research-playbooks.ts';

/**
 * Convert research sources + fetched content into SourceCacheEntry[] for
 * downstream modules (section-writer, citation-auditor).
 */
export function buildSourceCache(
  researchSources: ResearchResult['sources'],
  fetchedSources: FetchedSource[],
): SourceCacheEntry[] {
  // Index fetched sources by URL for fast lookup
  const fetchedByUrl = new Map<string, FetchedSource>();
  for (const fs of fetchedSources) {
    fetchedByUrl.set(fs.url, fs);
  }

  const cache: SourceCacheEntry[] = [];
  for (let i = 0; i < researchSources.length; i++) {
    const src = researchSources[i];
    if (!src.url) continue;

    const fetched = fetchedByUrl.get(src.url);
    const hasContent = fetched && fetched.status === 'ok' && fetched.content.length > MIN_SOURCE_CONTENT_LENGTH;

    cache.push({
      id: `SRC-${i + 1}`,
      url: src.url,
      title: fetched?.title || src.title || 'Unknown',
      author: src.author,
      date: src.date,
      // Prefer fetched content excerpts; fall back to LLM-extracted facts
      content: hasContent
        ? (fetched.relevantExcerpts.length > 0
          ? fetched.relevantExcerpts.join('\n\n---\n\n')
          : fetched.content.slice(0, 5000))
        : (src.facts?.join('\n') || ''),
      // Always include LLM-extracted facts as structured bullets
      facts: src.facts || [],
    });
  }

  return cache;
}

/**
 * Default minimum usable sources required by the research-phase gate.
 * Tuned to catch the QUA-315 failure mode (0/4 successful improves on
 * placeholder-heavy pages) without blocking legitimate edge cases.
 *   - standard: 1 (any usable source — light bar)
 *   - deep:    3 (the deep tier's whole purpose is multi-source grounding)
 */
export function defaultMinSources(deep: boolean): number {
  return deep ? 3 : 1;
}

export interface SourceGateInput {
  /** Source-cache entries built from the LLM's returned URLs + fetcher output. */
  sourceCache: SourceCacheEntry[] | undefined;
  /** Number of HTTP URLs the LLM agent returned (for the diagnostic message). */
  totalUrls: number;
  /** Number of LLM-returned source records (for the diagnostic message). */
  llmSourceCount: number;
  /**
   * Tier-aware minimum (already resolved from options.minSources / defaults).
   * Set to 0 to disable the gate.
   */
  minSources: number;
}

export interface SourceGateReport {
  /** True if the gate passed (or was disabled). */
  passed: boolean;
  /** True if the gate is enforcing (minSources > 0). */
  active: boolean;
  /** Count of usable cache entries (above the content-length threshold). */
  usableSources: number;
  /** Number of cache entries (regardless of usability). */
  cacheEntries: number;
  /** Content-length threshold below which an entry doesn't count as usable. */
  contentThreshold: number;
  /** Diagnostic message to pair with the throw / log. */
  diagnostic: string;
}

/**
 * Pure gate evaluation for the research phase. Decides whether the
 * downstream improve phase should be allowed to run based on how many
 * fetched sources actually carry usable content.
 *
 * Extracted from researchPhase so it can be unit-tested without mocking
 * the LLM agent or the network. (QUA-315)
 */
export function evaluateSourceGate(input: SourceGateInput): SourceGateReport {
  const { sourceCache, totalUrls, llmSourceCount, minSources } = input;
  const cacheEntries = sourceCache?.length || 0;
  const usableSources = (sourceCache || []).filter(
    e => e.url && e.content && e.content.length > MIN_SOURCE_CONTENT_LENGTH,
  ).length;
  const active = minSources > 0;
  const passed = !active || usableSources >= minSources;

  const diagnostic =
    `Got ${usableSources} usable source(s); need at least ${minSources}. ` +
    `Diagnostics: LLM agent returned ${llmSourceCount} sources with ${totalUrls} HTTP URL(s); ` +
    `${cacheEntries} were cached, ${usableSources} had usable content ` +
    `(>${MIN_SOURCE_CONTENT_LENGTH} chars).`;

  return { passed, active, usableSources, cacheEntries, contentThreshold: MIN_SOURCE_CONTENT_LENGTH, diagnostic };
}

export async function researchPhase(page: PageData, analysis: AnalysisResult, options: PipelineOptions): Promise<ResearchResult> {
  log('research', 'Starting research');

  const topics: string[] = analysis.researchNeeded || [];
  if (topics.length === 0) {
    // Analysis decided no research is needed. This is sometimes legitimate
    // (high-quality page with style-only gaps) but also a known silent-
    // failure mode where the analyzer under-detects citation gaps. We
    // surface it as a warning so reviewers see it in the log; the source
    // gate does not fire because no fetch was attempted.
    log('research', '⚠ No research topics identified by analysis — skipping research. If the page has placeholder citations, this is a misjudgment; consider re-running with --tier=deep or filing a follow-up.');
    return { sources: [] };
  }

  // Per-type research playbook (QUA-33): inject source recommendations so the
  // research agent prefers authoritative primary sources (SEC, institutional
  // profiles) over generic web search results.
  const playbook = loadPlaybook(page.entityType);
  const playbookSection = playbook
    ? `\n## Research Playbook for \`${playbook.entityType}\`\nPrefer these sources over generic web search where applicable, and be wary of the listed pitfalls.\n\n${formatPlaybookForPrompt(playbook)}\n`
    : '';
  if (playbook) {
    log('research', `Loaded research playbook for entityType="${playbook.entityType}"`);
  }

  const prompt = `Research the following topics to improve a wiki page about "${page.title}".

## Topics to Research
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${playbookSection}
## Research Instructions

For each topic:
1. Search SCRY (EA Forum/LessWrong) for relevant discussions
2. Search the web for authoritative sources

Use the tools provided to search. For each source found, extract:
- Title
- URL
- Author (if available)
- Date (if available)
- Key facts or quotes relevant to the topic

After researching, output a JSON object with:
{
  "sources": [
    {
      "topic": "which research topic this addresses",
      "title": "source title",
      "url": "source URL",
      "author": "author name",
      "date": "publication date",
      "facts": ["key fact 1", "key fact 2"],
      "relevance": "high/medium/low"
    }
  ],
  "summary": "brief summary of what was found"
}

Output ONLY valid JSON at the end.`;

  const tools = options.deep ? [
    {
      name: 'scry_search',
      description: 'Search EA Forum and LessWrong posts via SCRY',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          table: { type: 'string', enum: ['mv_eaforum_posts', 'mv_lesswrong_posts'], default: 'mv_eaforum_posts' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ] : [
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ];

  const result = await runAgent(prompt, {
    model: options.researchModel || MODELS.sonnet,
    maxTokens: 8000,
    tools
  });

  const research = parseAndValidate<ResearchResult>(result, ResearchResultSchema as z.ZodType<ResearchResult>, 'research', (raw, error) => ({
    sources: [],
    raw,
    error,
  }));

  writeTemp(page.id, 'research.json', research);
  log('research', `Complete (${research.sources?.length || 0} sources found)`);

  // ── Source fetching: build grounded source cache (#668) ──────────────────
  const urls = research.sources
    ?.map(s => s.url)
    .filter((u): u is string => !!u && u.startsWith('http')) || [];

  if (urls.length > 0) {
    log('research', `Fetching ${urls.length} source URL(s) via source-fetcher...`);
    const fetchRequests: FetchRequest[] = urls.map(url => ({
      url,
      extractMode: 'relevant' as const,
      query: page.title,
    }));

    try {
      const fetched = await fetchSources(fetchRequests, { concurrency: 3, delayMs: 500 });

      // Log fetch results
      const statusCounts = { ok: 0, paywall: 0, dead: 0, error: 0 };
      for (const f of fetched) statusCounts[f.status]++;
      log('research', `  Fetched: ${statusCounts.ok} ok, ${statusCounts.paywall} paywall, ${statusCounts.dead} dead, ${statusCounts.error} error`);

      // Build source cache
      research.sourceCache = buildSourceCache(research.sources || [], fetched);
      log('research', `  Source cache: ${research.sourceCache.length} entries`);

      writeTemp(page.id, 'source-cache.json', research.sourceCache);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('research', `  ⚠ Source fetching failed: ${error.message} — continuing without source cache`);
    }
  }

  // Source-coverage gate (QUA-315): abort before the expensive improve pass
  // when too few real sources landed. Otherwise synthesis hallucinates
  // placeholder `[^N]: Research data on X` footnotes.
  const minSources = options.minSources ?? defaultMinSources(options.deep === true);
  const gate = evaluateSourceGate({
    sourceCache: research.sourceCache,
    totalUrls: urls.length,
    llmSourceCount: research.sources?.length || 0,
    minSources,
  });

  log('research',
    `Source coverage report: ${research.sources?.length || 0} LLM sources, ${urls.length} URL(s) returned, ` +
    `${gate.cacheEntries} cache entries, ${gate.usableSources} usable (>${gate.contentThreshold} chars).`,
  );
  if (gate.active) {
    log('research', `Source gate: minSources=${minSources}, ${gate.passed ? 'PASS' : 'FAIL'} (use --skip-source-gate to bypass).`);
  } else {
    log('research', 'Source gate: disabled (minSources=0)');
  }

  if (!gate.passed) {
    throw new Error(
      `research: source-coverage gate failed for "${page.title}" (page ${page.id}). ` +
      `${gate.diagnostic} ` +
      `Aborting before improve to avoid synthesizing placeholder citations. ` +
      `Use --skip-source-gate to override, --min-sources=N to lower the threshold, ` +
      `or investigate why the research agent (Perplexity/SCRY/web_search) returned no usable URLs for this topic. (QUA-315)`,
    );
  }

  return research;
}
