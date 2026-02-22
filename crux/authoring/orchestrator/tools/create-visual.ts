/**
 * Tool: create_visual
 *
 * Analyzes visual elements on the current page: counts diagrams, tables,
 * and other visual components. Helps the orchestrator decide whether to
 * add visuals during a rewrite.
 * Cost: $0 (local analysis).
 */

import { countVisuals, extractVisuals } from '../../../lib/visual-detection.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'create_visual',
  cost: 0,
  definition: {
    name: 'create_visual',
    description:
      'Analyze visual elements on the current page: Mermaid diagrams, Squiggle estimates, comparison tables, cause-effect graphs, and markdown tables. Returns counts and positions of existing visuals. Use this to decide whether the page needs more visual content before calling rewrite_section to add it. Cost: $0 (local analysis).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    try {
      const counts = countVisuals(ctx.currentContent);
      const visuals = extractVisuals(ctx.currentContent);

      const response: Record<string, unknown> = {
        page_id: ctx.page.id,
        counts,
      };

      if (visuals.length > 0) {
        response.visuals = visuals.map((v) => ({
          type: v.type,
          line: v.line,
          preview: v.code.slice(0, 120),
        }));
      }

      // Provide actionable suggestions based on what's missing
      const suggestions: string[] = [];
      if (counts.mermaid === 0) {
        suggestions.push(
          'Consider adding a Mermaid diagram (flowchart, timeline, or relationship map) via rewrite_section.',
        );
      }
      if (counts['markdown-table'] === 0 && counts.comparison === 0 && counts['table-view'] === 0) {
        suggestions.push(
          'Consider adding a comparison table or data table to summarize key information.',
        );
      }
      if (suggestions.length > 0) {
        response.suggestions = suggestions;
      }

      return JSON.stringify(response, null, 2);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Visual analysis failed: ${error.message}` });
    }
  },
};
