/**
 * Tool: academic_lookup
 *
 * Standalone orchestrator tool for targeted Semantic Scholar lookups.
 * Lets the LLM make follow-up queries for specific papers or authors.
 * Cost: $0 (no LLM calls, only Semantic Scholar API).
 */

import { createSemanticScholarProvider } from '../../../lib/search/providers/semantic-scholar.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'academic_lookup',
  cost: 0,
  definition: {
    name: 'academic_lookup',
    description:
      'Look up academic papers or authors on Semantic Scholar. Returns paper metadata (title, abstract, citation count, year, authors) or author profiles. Use for targeted follow-up queries when you need specific academic data. Cost: $0.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query — author name, paper title, or research topic.',
        },
        search_type: {
          type: 'string',
          enum: ['papers', 'authors'],
          description: 'Type of academic search (default: papers)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5, max: 10)',
        },
      },
      required: ['query'],
    },
  },
  createHandler: (ctx) => async (input) => {
    const query = String(input.query);
    const searchType = String(input.search_type ?? 'papers');
    const maxResults = Math.min(Number(input.max_results ?? 5), 10);

    const provider = createSemanticScholarProvider();

    try {
      // Map search_type to entity type hints for the provider
      const entityTypeHint = searchType === 'authors' ? 'person' : 'concept';

      const hits = await provider.search(query, maxResults, entityTypeHint);

      // Add discovered URLs to the source cache
      const existingUrls = new Set(ctx.sourceCache.map(s => s.url));
      let newCount = 0;
      for (const hit of hits) {
        if (!existingUrls.has(hit.url)) {
          const nextId = ctx.sourceCache.length + 1;
          ctx.sourceCache.push({
            id: `S2-${nextId}`,
            url: hit.url,
            title: hit.title,
            content: hit.snippet ?? '',
            facts: [],
          });
          existingUrls.add(hit.url);
          newCount++;
        }
      }

      return JSON.stringify(
        {
          results: hits.map(h => ({
            title: h.title,
            url: h.url,
            details: h.snippet,
          })),
          newSourcesAdded: newCount,
          totalSourceCache: ctx.sourceCache.length,
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Academic lookup failed: ${error.message}` });
    }
  },
};
