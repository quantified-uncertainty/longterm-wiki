/**
 * Tool: suggest_cross_links
 *
 * Uses the wiki-server graph to find missing relatedEntries for the
 * current page's entity. Returns suggestions ranked by relevance score.
 * Cost: $0 (wiki-server query).
 */

import { getRelatedPages, getBacklinks } from '../../../lib/wiki-server/pages.ts';
import { getEntity } from '../../../lib/wiki-server/entities.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'suggest_cross_links',
  cost: 0,
  definition: {
    name: 'suggest_cross_links',
    description:
      'Suggest missing relatedEntries cross-links for the current page. Queries the wiki-server graph for related pages and backlinks, then identifies entities that are strongly connected but not yet in the frontmatter relatedEntries. Use this before calling edit_frontmatter to add the suggested links. Cost: $0 (wiki-server queries).',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of suggestions to return (default: 10)',
        },
      },
      required: [],
    },
  },
  createHandler: (ctx) => async (input) => {
    try {
      const limit = Math.min(Number(input.limit) || 10, 20);

      // Fetch related pages, backlinks, and current entity data in parallel
      const [relatedResult, backlinksResult, entityResult] = await Promise.all([
        getRelatedPages(ctx.page.id, 20),
        getBacklinks(ctx.page.id, 20),
        getEntity(ctx.page.id),
      ]);

      // Get existing relatedEntries from the entity
      const existingRelated = new Set<string>();
      if (entityResult.ok && entityResult.data.relatedEntries) {
        for (const r of entityResult.data.relatedEntries) {
          existingRelated.add(r.id);
        }
      }

      // Build scored candidates from related pages and backlinks
      const candidates = new Map<string, { score: number; reasons: string[]; title: string; type: string }>();

      if (relatedResult.ok) {
        for (const rel of relatedResult.data.related) {
          if (rel.id === ctx.page.id || existingRelated.has(rel.id)) continue;
          const existing = candidates.get(rel.id) || { score: 0, reasons: [], title: rel.title, type: rel.type };
          existing.score += rel.score || 1;
          existing.reasons.push(`Related page (score: ${rel.score}${rel.label ? `, ${rel.label}` : ''})`);
          candidates.set(rel.id, existing);
        }
      }

      if (backlinksResult.ok) {
        for (const bl of backlinksResult.data.backlinks) {
          const blId = String(bl.id);
          if (blId === ctx.page.id || existingRelated.has(blId)) continue;
          const existing = candidates.get(blId) || { score: 0, reasons: [], title: bl.title as string, type: bl.type as string };
          existing.score += (bl.weight as number) || 1;
          existing.reasons.push(`Backlink (${bl.linkType}${bl.relationship ? `: ${bl.relationship}` : ''})`);
          candidates.set(blId, existing);
        }
      }

      // Sort by score descending, take top N
      const suggestions = [...candidates.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([id, data]) => ({
          id,
          title: data.title,
          type: data.type,
          score: data.score,
          reasons: data.reasons,
        }));

      return JSON.stringify(
        {
          page_id: ctx.page.id,
          existingRelatedCount: existingRelated.size,
          suggestionCount: suggestions.length,
          suggestions,
          ...(suggestions.length > 0 && {
            hint: 'Use edit_frontmatter to add these to relatedEntries. Format: [{id: "entity-id", type: "relationship-type"}]',
          }),
          ...(suggestions.length === 0 && {
            message: 'No new cross-links to suggest. Existing relatedEntries cover the known connections.',
          }),
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({
        error: `Cross-link suggestion failed: ${error.message}`,
        hint: 'The wiki-server may be unavailable.',
      });
    }
  },
};
