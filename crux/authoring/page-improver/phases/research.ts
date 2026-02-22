/**
 * Research Phase
 *
 * Conducts web and SCRY searches to gather sources for page improvement.
 * After LLM-based search, fetches discovered URLs through the source-fetcher
 * to build a grounded source cache for downstream modules (#668).
 */

import { MODELS } from '../../../lib/anthropic.ts';
import { fetchSources, type FetchRequest, type FetchedSource } from '../../../lib/source-fetcher.ts';
import type { SourceCacheEntry } from '../../../lib/section-writer.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../types.ts';
import { log, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { parseAndValidate, ResearchResultSchema } from './json-parsing.ts';

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
    const hasContent = fetched && fetched.status === 'ok' && fetched.content.length > 50;

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

export async function researchPhase(page: PageData, analysis: AnalysisResult, options: PipelineOptions): Promise<ResearchResult> {
  log('research', 'Starting research');

  const topics: string[] = analysis.researchNeeded || [];
  if (topics.length === 0) {
    log('research', 'No research topics identified, skipping');
    return { sources: [] };
  }

  const prompt = `Research the following topics to improve a wiki page about "${page.title}".

## Topics to Research
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

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

  const research = parseAndValidate<ResearchResult>(result, ResearchResultSchema, 'research', (raw, error) => ({
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

  return research;
}
