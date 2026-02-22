/**
 * Tool: read_page
 *
 * Returns the full MDX content including frontmatter.
 * Cost: $0 (no external calls).
 */

import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'read_page',
  cost: 0,
  definition: {
    name: 'read_page',
    description:
      'Read the current page content. Returns the full MDX content including frontmatter. Use this to understand the current state of the page before making changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    return ctx.currentContent;
  },
};
