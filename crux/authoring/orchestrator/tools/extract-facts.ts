/**
 * Tool: extract_facts
 *
 * Previously returned canonical facts from data/facts/*.yaml.
 * The YAML facts pipeline has been retired. This tool now returns
 * an empty result. It remains registered so orchestrator tool lists
 * don't break, but it does no work.
 * Cost: $0.
 */

import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'extract_facts',
  cost: 0,
  definition: {
    name: 'extract_facts',
    description:
      'List canonical facts available for this page. The YAML facts pipeline has been retired — this tool currently returns an empty result. Cost: $0.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => {
    return async () => {
      return JSON.stringify({
        page_id: ctx.page.id,
        message: 'The data/facts/*.yaml pipeline has been retired. No canonical facts available from this source.',
        factCount: 0,
      });
    };
  },
};
