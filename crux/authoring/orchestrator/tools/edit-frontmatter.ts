/**
 * Tool: edit_frontmatter
 *
 * Updates specific frontmatter fields in the current page.
 * Only safe, non-structural fields may be updated.
 * Cost: $0 (no LLM).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { reorderFrontmatterObject } from '../../../lib/frontmatter-order.ts';
import { ensureMdxSafeYaml } from '../../../lib/yaml-mdx-safe.ts';
import type { ToolRegistration } from './types.ts';

/** Fields the edit_frontmatter tool is allowed to update. */
export const EDITABLE_FRONTMATTER_FIELDS = new Set([
  'llmSummary',
  'description',
  'lastEdited',
  'quality',
  'relatedEntries',
  'tags',
  'readerImportance',
  'update_frequency',
]);

export const tool: ToolRegistration = {
  name: 'edit_frontmatter',
  cost: 0,
  definition: {
    name: 'edit_frontmatter',
    description: `Update specific frontmatter fields in the current page. Only these fields may be updated: ${[...EDITABLE_FRONTMATTER_FIELDS].join(', ')}. Preserves all other fields and field ordering. Cost: $0 (no LLM).`,
    input_schema: {
      type: 'object' as const,
      properties: {
        fields: {
          type: 'object',
          description:
            'A JSON object of field:value pairs to update in the frontmatter. Only allowed fields will be accepted.',
        },
      },
      required: ['fields'],
    },
  },
  createHandler: (ctx) => async (input) => {
    try {
      const fields = input.fields as Record<string, unknown> | undefined;
      if (!fields || typeof fields !== 'object') {
        return JSON.stringify({ error: 'fields parameter must be a JSON object of field:value pairs' });
      }

      const requestedFields = Object.keys(fields);
      const rejectedFields = requestedFields.filter((f) => !EDITABLE_FRONTMATTER_FIELDS.has(f));
      if (rejectedFields.length > 0) {
        return JSON.stringify({
          error: `Cannot update disallowed field(s): ${rejectedFields.join(', ')}. Allowed fields: ${[...EDITABLE_FRONTMATTER_FIELDS].join(', ')}`,
        });
      }

      if (requestedFields.length === 0) {
        return JSON.stringify({ error: 'No fields provided to update' });
      }

      const fmMatch = ctx.currentContent.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        return JSON.stringify({
          error: 'No valid YAML frontmatter found in current content (expected --- delimiters)',
        });
      }

      let fm: Record<string, unknown>;
      try {
        fm = (parseYaml(fmMatch[1]) || {}) as Record<string, unknown>;
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return JSON.stringify({ error: `Failed to parse frontmatter YAML: ${msg}` });
      }

      const updatedFields: string[] = [];
      for (const [key, value] of Object.entries(fields)) {
        fm[key] = value;
        updatedFields.push(key);
      }

      if (fm.lastEdited instanceof Date) {
        fm.lastEdited = fm.lastEdited.toISOString().split('T')[0];
      }

      const orderedFm = reorderFrontmatterObject(fm);

      let newFmStr = stringifyYaml(orderedFm, {
        defaultStringType: 'PLAIN',
        defaultKeyType: 'PLAIN',
        lineWidth: 0,
      });

      // Ensure \$ in plain YAML values are double-quoted for MDX safety.
      // Without this, remark-mdx-frontmatter converts \$ to invalid JS escapes.
      newFmStr = ensureMdxSafeYaml(newFmStr);

      // Date strings must be quoted to prevent YAML parsing them as Date objects
      newFmStr = newFmStr.replace(/^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})$/m, '$1"$2"');

      if (!newFmStr.endsWith('\n')) {
        newFmStr += '\n';
      }

      const bodyStart = ctx.currentContent.indexOf('---', 4) + 3;
      let body = ctx.currentContent.slice(bodyStart);
      body = '\n' + body.replace(/^\n+/, '');
      ctx.currentContent = `---\n${newFmStr}---${body}`;

      ctx.splitPage = null;
      ctx.sections = null;

      return JSON.stringify(
        {
          updatedFields,
          fieldCount: updatedFields.length,
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Frontmatter edit failed: ${error.message}` });
    }
  },
};
