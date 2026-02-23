/**
 * Tool: add_references
 *
 * Appends or updates a <References> bibliography block at the end of the page
 * by collecting <R id="..."> inline citations and cited_by reverse index from
 * resource YAML. Idempotent and purely mechanical (no LLM calls). Cost: $0.
 */

import { enrichReferences } from '../../../enrich/enrich-references.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'add_references',
  cost: 0,
  definition: {
    name: 'add_references',
    description:
      'Append or update a <References> bibliography block at the end of the page. Collects resource IDs from inline <R> citations and the cited_by reverse index. Idempotent, no LLM calls. Cost: $0.',
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
        const result = enrichReferences(ctx.currentContent, {
          pageId: ctx.page.id,
          root: ROOT,
        });
        ctx.currentContent = result.content;
        // Invalidate section cache since content changed
        ctx.splitPage = null;
        ctx.sections = null;

        return JSON.stringify(
          {
            action: result.action,
            refCount: result.refCount,
            sampleIds: result.ids.slice(0, 5),
          },
          null,
          2,
        );
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `References enrichment failed: ${error.message}` });
      }
    };
  },
};
