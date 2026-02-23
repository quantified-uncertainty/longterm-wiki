/**
 * Tool: run_research
 *
 * Multi-source research (Exa, Perplexity, SCRY). Fetches URLs, extracts
 * structured facts, and adds results to the context's source cache.
 * Cost: ~$1.50 per call.
 */

import { runResearch, type ResearchRequest } from '../../../lib/research-agent.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'run_research',
  cost: 1.50,
  definition: {
    name: 'run_research',
    description:
      'Run multi-source research on a topic. Searches Exa, Perplexity, and SCRY (EA Forum/LessWrong), fetches source URLs, and extracts structured facts. Results are added to the source cache for use by rewrite_section. Cost: $1-3 per call.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'The topic to research (e.g. "Anthropic constitutional AI safety")',
        },
        query: {
          type: 'string',
          description: 'Optional more specific search query (defaults to topic)',
        },
      },
      required: ['topic'],
    },
  },
  createHandler: (ctx) => async (input) => {
    const topic = String(input.topic);
    const query = input.query ? String(input.query) : undefined;
    ctx.researchQueryCount++;

    if (ctx.researchQueryCount > ctx.budget.maxResearchQueries) {
      return JSON.stringify({
        error: `Research query budget exceeded (max ${ctx.budget.maxResearchQueries} for ${ctx.budget.name} tier). Improve the page with existing sources.`,
      });
    }

    try {
      const request: ResearchRequest = {
        topic,
        query,
        pageContext: {
          title: ctx.page.title,
          type: ctx.page.entityType || 'unknown',
          entityId: ctx.page.id,
        },
        budgetCap: 3.00,
      };

      const result = await runResearch(request);

      // Merge new sources into the context's source cache
      const existingUrls = new Set(ctx.sourceCache.map((s) => s.url));
      let newCount = 0;
      for (const src of result.sources) {
        if (!existingUrls.has(src.url)) {
          ctx.sourceCache.push(src);
          existingUrls.add(src.url);
          newCount++;
        }
      }

      return JSON.stringify(
        {
          sourcesFound: result.sources.length,
          newSourcesAdded: newCount,
          totalSourceCache: ctx.sourceCache.length,
          cost: result.metadata.totalCost,
          providers: result.metadata.sourcesSearched,
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Research failed: ${error.message}` });
    }
  },
};
