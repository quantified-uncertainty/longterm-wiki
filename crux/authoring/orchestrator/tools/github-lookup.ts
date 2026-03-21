/**
 * Tool: github_lookup
 *
 * Standalone orchestrator tool for targeted GitHub lookups.
 * Lets the LLM make follow-up queries for specific repos, orgs, or users.
 * Cost: $0 (no LLM calls, only GitHub API).
 */

import { createGitHubProvider } from '../../../lib/search/providers/github-search.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'github_lookup',
  cost: 0,
  definition: {
    name: 'github_lookup',
    description:
      'Look up GitHub repositories, organizations, or users. Returns structured data (repo stats, description, language, stars, last updated). Use for targeted follow-up queries when you need specific GitHub data. Cost: $0.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Can be a repo reference (e.g. "anthropic/claude-code"), org name, or search terms.',
        },
        search_type: {
          type: 'string',
          enum: ['repos', 'orgs', 'users'],
          description: 'Type of GitHub search (default: repos)',
        },
      },
      required: ['query'],
    },
  },
  createHandler: (ctx) => async (input) => {
    const query = String(input.query);
    const searchType = String(input.search_type ?? 'repos');

    const provider = createGitHubProvider();
    if (!provider.isAvailable()) {
      return JSON.stringify({ error: 'GITHUB_TOKEN not set — cannot access GitHub API' });
    }

    try {
      // Map search_type to entity type hints for the provider
      const entityTypeHint =
        searchType === 'orgs' ? 'organization' :
        searchType === 'users' ? 'person' :
        'project';

      const hits = await provider.search(query, 5, entityTypeHint);

      // Add discovered URLs to the source cache
      const existingUrls = new Set(ctx.sourceCache.map(s => s.url));
      let newCount = 0;
      for (const hit of hits) {
        if (!existingUrls.has(hit.url)) {
          const nextId = ctx.sourceCache.length + 1;
          ctx.sourceCache.push({
            id: `GH-${nextId}`,
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
      return JSON.stringify({ error: `GitHub lookup failed: ${error.message}` });
    }
  },
};
