/**
 * Tool: read_related_page
 *
 * Reads another wiki page's MDX content by page ID. Essential for
 * cross-page consistency checks (dates, funding, team sizes).
 * Cost: $0 (local file read).
 */

import fs from 'fs';
import path from 'path';
import { loadPages as loadPagesFromRegistry } from '../../../lib/content-types.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'read_related_page',
  cost: 0,
  definition: {
    name: 'read_related_page',
    description:
      'Read another wiki page by its page ID. Use this for cross-page consistency checks — e.g. verifying that a person page agrees with the linked organization page on dates, funding, or key people. Returns the first ~2000 words of the page content. Cannot read the current page (use read_page for that).',
    input_schema: {
      type: 'object' as const,
      properties: {
        page_id: {
          type: 'string',
          description: 'The page ID to read (e.g. "anthropic", "miri", "eliezer-yudkowsky")',
        },
      },
      required: ['page_id'],
    },
  },
  createHandler: (ctx) => {
    const ROOT = ctx.filePath.replace(/\/content\/docs\/.*$/, '');

    return async (input) => {
      const pageId = String(input.page_id || '').trim();

      if (!pageId) {
        return JSON.stringify({ error: 'page_id is required' });
      }

      if (pageId === ctx.page.id) {
        return JSON.stringify({
          error: `"${pageId}" is the current page. Use the read_page tool instead.`,
        });
      }

      const pages = loadPagesFromRegistry();
      const targetPage = pages.find((p) => p.id === pageId);

      if (!targetPage) {
        return JSON.stringify({
          error: `Page "${pageId}" not found in the pages registry.`,
        });
      }

      const cleanPath = targetPage.path.replace(/^\/|\/$/g, '');
      const filePath = path.join(ROOT, 'content/docs', cleanPath + '.mdx');

      if (!fs.existsSync(filePath)) {
        return JSON.stringify({
          error: `File not found for page "${pageId}" at ${filePath}`,
        });
      }

      const content = fs.readFileSync(filePath, 'utf-8');

      const words = content.split(/\s+/);
      const truncated = words.length > 2000;
      const result = truncated ? words.slice(0, 2000).join(' ') : content;

      return (
        JSON.stringify({
          page_id: pageId,
          title: targetPage.title,
          truncated,
          wordCount: words.length,
        }) +
        '\n\n' +
        result
      );
    };
  },
};
