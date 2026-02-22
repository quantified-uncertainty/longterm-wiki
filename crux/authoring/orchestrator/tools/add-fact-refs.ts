/**
 * Tool: add_fact_refs
 *
 * Scans page content and wraps hardcoded numbers with <F> (canonical fact)
 * tags where matching facts exist in the YAML data layer. Idempotent.
 * Cost: ~$0.05 (Haiku).
 */

import { enrichFactRefs } from '../../../enrich/enrich-fact-refs.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'add_fact_refs',
  cost: 0.05,
  definition: {
    name: 'add_fact_refs',
    description:
      'Scan the current page content and wrap hardcoded numbers with <F> (canonical fact) tags where matching facts exist in the YAML data layer. Idempotent. Cost: ~$0.05 (Haiku).',
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
        const result = await enrichFactRefs(ctx.currentContent, {
          pageId: ctx.page.id,
          root: ROOT,
        });
        ctx.currentContent = result.content;
        // Invalidate section cache since content changed
        ctx.splitPage = null;
        ctx.sections = null;

        return JSON.stringify(
          {
            insertedCount: result.insertedCount,
            replacements: result.replacements.slice(0, 10).map((r) => ({
              text: r.searchText,
              entityId: r.entityId,
              factId: r.factId,
            })),
          },
          null,
          2,
        );
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Fact ref enrichment failed: ${error.message}` });
      }
    };
  },
};
