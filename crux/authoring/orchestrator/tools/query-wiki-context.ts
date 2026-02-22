/**
 * Tool: query_wiki_context
 *
 * Queries the wiki-server for page context: related pages, backlinks,
 * entity metadata, and hallucination risk score. Gives the orchestrator
 * awareness of the wiki graph.
 * Cost: $0 (local query, no LLM).
 */

import { getPage, getRelatedPages, getBacklinks } from '../../../lib/wiki-server/pages.ts';
import { getEntity } from '../../../lib/wiki-server/entities.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'query_wiki_context',
  cost: 0,
  definition: {
    name: 'query_wiki_context',
    description:
      'Query the wiki-server for page context: related pages, backlinks, entity metadata, and hallucination risk score. Gives you awareness of the wiki graph — what links here, what this page relates to, and how risky it is. Use this early to understand cross-page context before rewriting. Cost: $0 (local query, no LLM).',
    input_schema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description:
            'Optional entity ID to look up (defaults to the current page ID). Use this to query a different entity than the current page.',
        },
      },
      required: [],
    },
  },
  createHandler: (ctx) => async (input) => {
    const entityId = input.entity_id ? String(input.entity_id) : ctx.page.id;
    const pageId = ctx.page.id;

    try {
      const [pageResult, relatedResult, backlinksResult, entityResult] = await Promise.all([
        getPage(pageId),
        getRelatedPages(pageId, 10),
        getBacklinks(pageId, 10),
        getEntity(entityId),
      ]);

      const response: Record<string, unknown> = {};

      if (pageResult.ok) {
        const p = pageResult.data;
        response.page = {
          id: p.id,
          title: p.title,
          entityType: p.entityType,
          category: p.category,
          subcategory: p.subcategory,
          quality: p.quality,
          readerImportance: p.readerImportance,
          wordCount: p.wordCount,
          lastUpdated: p.lastUpdated,
          hallucinationRisk: {
            level: p.hallucinationRiskLevel,
            score: p.hallucinationRiskScore,
          },
        };
      } else {
        response.page = { error: `Could not fetch page: ${pageResult.message}` };
      }

      if (relatedResult.ok) {
        response.relatedPages = {
          total: relatedResult.data.total,
          items: relatedResult.data.related.map((r: Record<string, unknown>) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            score: r.score,
            label: r.label,
          })),
        };
      } else {
        response.relatedPages = { error: `Could not fetch related pages: ${relatedResult.message}` };
      }

      if (backlinksResult.ok) {
        response.backlinks = {
          total: backlinksResult.data.total,
          items: backlinksResult.data.backlinks.map((b: Record<string, unknown>) => ({
            id: b.id,
            title: b.title,
            type: b.type,
            relationship: b.relationship,
            linkType: b.linkType,
          })),
        };
      } else {
        response.backlinks = { error: `Could not fetch backlinks: ${backlinksResult.message}` };
      }

      if (entityResult.ok) {
        const e = entityResult.data;
        response.entity = {
          id: e.id,
          entityType: e.entityType,
          title: e.title,
          description: e.description?.slice(0, 300),
          status: e.status,
          website: e.website,
          tags: e.tags,
          relatedEntities: e.relatedEntries?.slice(0, 10).map((r: Record<string, unknown>) => ({
            id: r.id,
            type: r.type,
            relationship: r.relationship,
          })),
        };
      } else {
        response.entity = { error: `Could not fetch entity "${entityId}": ${entityResult.message}` };
      }

      return JSON.stringify(response, null, 2);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({
        error: `Wiki context query failed: ${error.message}`,
        hint: 'The wiki-server may be unavailable. Check LONGTERMWIKI_SERVER_URL.',
      });
    }
  },
};
