/**
 * Tool: deep_citation_check
 *
 * Extracts citation metadata from the current page: footnote URLs,
 * claim context, and link text. Provides a structured view of all
 * citations so the orchestrator can identify weak or missing citations
 * without running a full LLM-based audit.
 * Cost: $0 (local parsing).
 */

import { extractCitationsFromContent } from '../../../lib/citation-archive.ts';
import { stripFrontmatter } from '../../../lib/patterns.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'deep_citation_check',
  cost: 0,
  definition: {
    name: 'deep_citation_check',
    description:
      'Extract and analyze all citations on the current page. Returns structured citation data: footnote numbers, URLs, link text, and surrounding claim context. Use this to identify uncited claims, duplicate sources, or weak citations before rewriting. For full LLM-based verification against source URLs, use audit_citations instead. Cost: $0 (local parsing).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    try {
      const body = stripFrontmatter(ctx.currentContent);
      const citations = extractCitationsFromContent(body);

      if (citations.length === 0) {
        return JSON.stringify({
          page_id: ctx.page.id,
          message: 'No citations found on this page.',
          citationCount: 0,
        });
      }

      // Detect duplicate URLs
      const urlCounts = new Map<string, number>();
      for (const c of citations) {
        urlCounts.set(c.url, (urlCounts.get(c.url) || 0) + 1);
      }
      const duplicateUrls = [...urlCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([url, count]) => ({ url, count }));

      // Count unique domains
      const domains = new Set<string>();
      for (const c of citations) {
        try {
          domains.add(new URL(c.url).hostname);
        } catch {
          // Skip malformed URLs
        }
      }

      return JSON.stringify(
        {
          page_id: ctx.page.id,
          citationCount: citations.length,
          uniqueUrls: urlCounts.size,
          uniqueDomains: domains.size,
          duplicateUrls: duplicateUrls.length > 0 ? duplicateUrls : undefined,
          citations: citations.map((c) => ({
            footnote: c.footnote,
            url: c.url,
            linkText: c.linkText.slice(0, 80),
            claimContext: c.claimContext.slice(0, 150),
          })),
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Citation check failed: ${error.message}` });
    }
  },
};
