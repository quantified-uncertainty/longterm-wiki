/**
 * Tool: split_into_sections
 *
 * Splits the current page into ## sections and returns metadata.
 * Cost: $0 (no external calls).
 */

import { splitIntoSections } from '../../../lib/section-splitter.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'split_into_sections',
  cost: 0,
  definition: {
    name: 'split_into_sections',
    description:
      'Split the current page into ## sections. Returns the list of section IDs and their headings. Use this to plan which sections to rewrite.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    const split = splitIntoSections(ctx.currentContent);
    ctx.splitPage = split;
    ctx.sections = split.sections;
    const sectionInfo = split.sections.map((s) => ({
      id: s.id,
      heading: s.heading.trim(),
      wordCount: s.content.split(/\s+/).filter(Boolean).length,
    }));
    return JSON.stringify(
      {
        sectionCount: split.sections.length,
        hasFrontmatter: split.frontmatter.length > 0,
        preambleLength: split.preamble.split(/\s+/).filter(Boolean).length,
        sections: sectionInfo,
      },
      null,
      2,
    );
  },
};
