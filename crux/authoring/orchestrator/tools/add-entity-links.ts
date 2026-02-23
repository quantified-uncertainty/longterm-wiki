/**
 * Tool: add_entity_links
 *
 * Scans page content and inserts <EntityLink> tags for unlinked entity mentions.
 * Filters out self-links (page shouldn't link to itself). Idempotent.
 * Cost: ~$0.05 (Haiku).
 */

import { enrichEntityLinks } from '../../../enrich/enrich-entity-links.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'add_entity_links',
  cost: 0.05,
  definition: {
    name: 'add_entity_links',
    description:
      'Scan the current page content and insert <EntityLink> tags for entity mentions that are not yet linked. Idempotent — safe to call multiple times. Cost: ~$0.05 (Haiku).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => {
    const ROOT = ctx.filePath.replace(/\/content\/docs\/.*$/, '');

    return async () => {
      try {
        const result = await enrichEntityLinks(ctx.currentContent, { root: ROOT });

        // Prevent self-linking: extract the page's own entity ID from DataInfoBox
        // and strip any EntityLink tags pointing to it
        const selfEntityMatch = ctx.currentContent.match(/<DataInfoBox\s+entityId="([^"]+)"/);
        let enrichedContent = result.content;
        let selfFilteredReplacements = result.replacements;
        if (selfEntityMatch) {
          const selfId = selfEntityMatch[1];
          const selfLinkRe = new RegExp(
            `<EntityLink\\s[^>]*id="${selfId}"[^>]*>([\\s\\S]*?)</EntityLink>`,
            'g',
          );
          enrichedContent = enrichedContent.replace(selfLinkRe, '$1');
          selfFilteredReplacements = result.replacements.filter((r) => r.entityId !== selfId);
        }

        ctx.currentContent = enrichedContent;
        // Invalidate section cache since content changed
        ctx.splitPage = null;
        ctx.sections = null;

        return JSON.stringify(
          {
            insertedCount: selfFilteredReplacements.length,
            replacements: selfFilteredReplacements.slice(0, 10).map((r) => ({
              text: r.searchText,
              entityId: r.entityId,
            })),
          },
          null,
          2,
        );
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Entity link enrichment failed: ${error.message}` });
      }
    };
  },
};
