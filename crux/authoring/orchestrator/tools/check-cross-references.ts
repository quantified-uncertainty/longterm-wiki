/**
 * Tool: check_cross_references
 *
 * Reads top related pages and compares key claims (dates, numbers, names)
 * against the current page to detect contradictions. Uses query_wiki_context
 * for graph data and read_related_page for content access.
 * Cost: ~$0.20 (Haiku for claim extraction).
 */

import { getRelatedPages } from '../../../lib/wiki-server/pages.ts';
import { loadPages as loadPagesFromRegistry } from '../../../lib/content-types.ts';
import fs from 'fs';
import path from 'path';
import type { ToolRegistration } from './types.ts';

/** Extract key factual claims (dates, numbers, dollar amounts) from content. */
function extractClaims(content: string): Array<{ claim: string; type: string }> {
  const claims: Array<{ claim: string; type: string }> = [];

  // Founding/establishment dates: "founded in 2015", "established in 2020"
  for (const match of content.matchAll(/(?:founded|established|created|started|launched|began)\s+in\s+(\d{4})/gi)) {
    claims.push({ claim: `Founded/started in ${match[1]}`, type: 'date' });
  }

  // Dollar amounts: "$1.5 billion", "$500 million", "$2M"
  for (const match of content.matchAll(/\$[\d,.]+\s*(?:billion|million|trillion|B|M|K|T)/gi)) {
    claims.push({ claim: match[0], type: 'funding' });
  }

  // Employee/team sizes: "200 employees", "team of 50"
  for (const match of content.matchAll(/(?:(\d[\d,]*)\s+(?:employees?|staff|researchers?|people|members?)|team\s+of\s+(\d[\d,]*))/gi)) {
    const num = match[1] || match[2];
    claims.push({ claim: `${num} people/employees`, type: 'headcount' });
  }

  // Year ranges: "from 2018 to 2023", "2020-2024"
  for (const match of content.matchAll(/(\d{4})\s*[-–—to]+\s*(\d{4})/g)) {
    claims.push({ claim: `Period: ${match[1]}-${match[2]}`, type: 'date_range' });
  }

  return claims;
}

export const tool: ToolRegistration = {
  name: 'check_cross_references',
  cost: 0,
  definition: {
    name: 'check_cross_references',
    description:
      'Check for factual contradictions between the current page and its most closely related pages. Extracts key claims (dates, funding amounts, team sizes) from the current page and top related pages, then flags potential inconsistencies. Use this after rewriting to catch cross-page contradictions. Cost: $0 (local parsing + wiki-server queries).',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_pages: {
          type: 'number',
          description: 'Maximum number of related pages to check (default: 3, max: 5)',
        },
      },
      required: [],
    },
  },
  createHandler: (ctx) => {
    const ROOT = ctx.filePath.replace(/\/content\/docs\/.*$/, '');

    return async (input) => {
      try {
        const maxPages = Math.min(Number(input.max_pages) || 3, 5);

        // Get related pages from wiki-server
        const relatedResult = await getRelatedPages(ctx.page.id, maxPages);
        if (!relatedResult.ok) {
          return JSON.stringify({
            error: `Could not fetch related pages: ${relatedResult.message}`,
            hint: 'Wiki-server may be unavailable. Cross-reference check requires the wiki-server.',
          });
        }

        const related = relatedResult.data.related;
        if (related.length === 0) {
          return JSON.stringify({
            page_id: ctx.page.id,
            message: 'No related pages found for cross-reference checking.',
            contradictions: [],
          });
        }

        // Extract claims from current page
        const currentClaims = extractClaims(ctx.currentContent);

        // Read related pages and extract their claims
        const pages = loadPagesFromRegistry();
        const contradictions: Array<{
          relatedPageId: string;
          relatedPageTitle: string;
          currentClaim: string;
          relatedClaim: string;
          claimType: string;
        }> = [];

        const checkedPages: string[] = [];

        for (const rel of related) {
          const targetPage = pages.find((p) => p.id === rel.id);
          if (!targetPage) continue;

          const cleanPath = targetPage.path.replace(/^\/?|\/?$/g, '');
          const filePath = path.join(ROOT, 'content/docs', cleanPath + '.mdx');

          if (!fs.existsSync(filePath)) continue;

          const relContent = fs.readFileSync(filePath, 'utf-8');
          const relClaims = extractClaims(relContent);
          checkedPages.push(rel.id);

          // Compare claims of same type for contradictions
          for (const cc of currentClaims) {
            for (const rc of relClaims) {
              if (cc.type === rc.type && cc.claim !== rc.claim) {
                // Same type but different values — potential contradiction
                contradictions.push({
                  relatedPageId: rel.id,
                  relatedPageTitle: rel.title,
                  currentClaim: cc.claim,
                  relatedClaim: rc.claim,
                  claimType: cc.type,
                });
              }
            }
          }
        }

        return JSON.stringify(
          {
            page_id: ctx.page.id,
            pagesChecked: checkedPages,
            currentClaimCount: currentClaims.length,
            contradictionCount: contradictions.length,
            contradictions: contradictions.slice(0, 15),
            ...(contradictions.length === 0 && {
              message: 'No contradictions detected between this page and related pages.',
            }),
          },
          null,
          2,
        );
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Cross-reference check failed: ${error.message}` });
      }
    };
  },
};
