/**
 * Tool: view_edit_history
 *
 * Reads the edit log for the current page from the wiki-server DB.
 * Gives the orchestrator context about when and how the page was
 * last edited, which helps it avoid redundant work.
 * Cost: $0 (API read).
 */

import { readEditLog } from '../../../lib/session/edit-log.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'view_edit_history',
  cost: 0,
  definition: {
    name: 'view_edit_history',
    description:
      'View the edit history for the current page. Returns a list of past edits with dates, tools used, and notes. Use this early to understand what has already been done to the page and avoid redundant work. Cost: $0 (API read).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    try {
      const entries = await readEditLog(ctx.page.id);

      if (entries.length === 0) {
        return JSON.stringify({
          page_id: ctx.page.id,
          message: 'No edit history found for this page.',
          entries: [],
        });
      }

      // Return the most recent 20 entries (most recent first)
      const recent = entries.slice(-20).reverse();

      return JSON.stringify(
        {
          page_id: ctx.page.id,
          totalEntries: entries.length,
          showing: recent.length,
          entries: recent.map((e) => ({
            date: e.date,
            tool: e.tool,
            agency: e.agency,
            ...(e.requestedBy && { requestedBy: e.requestedBy }),
            ...(e.note && { note: e.note }),
          })),
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({
        error: `Failed to read edit history: ${error.message}`,
        hint: 'The wiki-server may be unavailable.',
      });
    }
  },
};
