/**
 * Tool: rewrite_section
 *
 * Rewrites a single ## section using the source cache for grounded,
 * cited content. Updates the context's section split and full page.
 * Cost: ~$0.20 per section.
 */

import {
  splitIntoSections,
  reassembleSections,
  renumberFootnotes,
  filterSourcesForSection,
} from '../../../lib/section-splitter.ts';
import { rewriteSection } from '../../../lib/section-writer.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'rewrite_section',
  cost: 0.20,
  definition: {
    name: 'rewrite_section',
    description:
      'Rewrite a single ## section of the page. Uses the source cache for grounded, cited content. Each call improves one section — call multiple times for multiple sections. The section must exist in the current page. Cost: $0.10-0.30 per section.',
    input_schema: {
      type: 'object' as const,
      properties: {
        section_id: {
          type: 'string',
          description:
            'The section ID to rewrite (from split_into_sections output, e.g. "background")',
        },
        directions: {
          type: 'string',
          description:
            'Specific improvement directions for this section (optional — general directions are already provided)',
        },
      },
      required: ['section_id'],
    },
  },
  createHandler: (ctx, options) => async (input) => {
    const sectionId = String(input.section_id);
    const sectionDirections = input.directions ? String(input.directions) : undefined;

    // Ensure we have a current section split
    if (!ctx.splitPage) {
      const split = splitIntoSections(ctx.currentContent);
      ctx.splitPage = split;
      ctx.sections = split.sections;
    }

    const section = ctx.sections?.find((s) => s.id === sectionId);
    if (!section) {
      const available = ctx.sections?.map((s) => s.id).join(', ') || 'none';
      return JSON.stringify({
        error: `Section "${sectionId}" not found. Available sections: ${available}`,
      });
    }

    // Filter sources relevant to this section
    const sectionSources = filterSourcesForSection(section, ctx.sourceCache);

    try {
      const result = await rewriteSection(
        {
          sectionId: section.id,
          sectionContent: section.content,
          pageContext: {
            title: ctx.page.title,
            type: ctx.page.entityType || 'wiki-page',
            entityId: ctx.page.id,
          },
          sourceCache: sectionSources,
          directions: [
            ctx.directions,
            sectionDirections,
            'Preserve any existing Markdown tables — improve their data if needed but do not replace them with prose.',
          ]
            .filter(Boolean)
            .join('\n'),
          constraints: {
            allowTrainingKnowledge: sectionSources.length === 0,
            requireClaimMap: sectionSources.length > 0,
          },
        },
        { model: options.writerModel },
      );

      // Update the section in context
      const sectionIdx = ctx.sections!.findIndex((s) => s.id === sectionId);
      if (sectionIdx !== -1) {
        ctx.sections![sectionIdx] = {
          id: section.id,
          heading: section.heading,
          content: result.content,
        };

        // Reassemble the full page from updated sections
        const reassembled = reassembleSections({
          frontmatter: ctx.splitPage!.frontmatter,
          preamble: ctx.splitPage!.preamble,
          sections: ctx.sections!,
        });
        ctx.currentContent = renumberFootnotes(reassembled);
      }

      return JSON.stringify(
        {
          sectionId,
          claimMapEntries: result.claimMap.length,
          unsourceableClaims: result.unsourceableClaims.length,
          wordsBefore: section.content.split(/\s+/).length,
          wordsAfter: result.content.split(/\s+/).length,
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Section rewrite failed: ${error.message}` });
    }
  },
};
