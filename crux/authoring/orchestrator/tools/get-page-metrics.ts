/**
 * Tool: get_page_metrics
 *
 * Extracts quality metrics from the current page content.
 * Cost: $0 (no external calls).
 */

import { extractQualityMetrics } from './metrics.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'get_page_metrics',
  cost: 0,
  definition: {
    name: 'get_page_metrics',
    description:
      'Extract quality metrics from the current page content: word count, footnote/citation count, EntityLink count, diagram count, table count, section count, and structural score.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    const metrics = extractQualityMetrics(ctx.currentContent, ctx.filePath);
    return JSON.stringify(metrics, null, 2);
  },
};
