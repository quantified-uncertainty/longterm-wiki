/**
 * Tool: extract_facts
 *
 * Returns the canonical facts available for this page and related entities.
 * Helps the orchestrator know which <F> tags can be used and what their
 * current values are.
 * Cost: $0 (local YAML read).
 */

import { buildFactLookupForContent } from '../../../lib/fact-lookup.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'extract_facts',
  cost: 0,
  definition: {
    name: 'extract_facts',
    description:
      'List canonical facts available for this page and its related entities. Returns fact IDs, values, units, and temporal context. Use this to understand which <F> tags exist before rewriting — you can reference these facts in prose with <F id="entity.factId" />. Cost: $0 (local YAML read).',
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
        const factTable = buildFactLookupForContent(ctx.page.id, ctx.currentContent, ROOT);

        if (!factTable) {
          return JSON.stringify({
            page_id: ctx.page.id,
            message: 'No canonical facts found for this page or related entities.',
            factCount: 0,
          });
        }

        // Count facts for the summary
        const factLines = factTable.split('\n').filter((l) => l.includes(': "'));
        const entitySections = factTable.split('\n').filter((l) => l.startsWith('# '));

        return JSON.stringify(
          {
            page_id: ctx.page.id,
            entityCount: entitySections.length,
            factCount: factLines.length,
            hint: 'Use <F id="entity.factId" /> in rewritten sections to reference these facts.',
          },
          null,
          2,
        ) + '\n\n' + factTable;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Fact extraction failed: ${error.message}` });
      }
    };
  },
};
