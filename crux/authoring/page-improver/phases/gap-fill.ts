/**
 * Gap Fill Phase
 *
 * Uses review feedback to fix remaining issues in the improved content.
 */

import { MODELS } from '../../../lib/anthropic.ts';
import type { PageData, ReviewResult, PipelineOptions } from '../types.ts';
import { log, writeTemp, repairFrontmatter } from '../utils.ts';
import { runAgent } from '../api.ts';

export async function gapFillPhase(page: PageData, improvedContent: string, review: ReviewResult, options: PipelineOptions): Promise<string> {
  log('gap-fill', 'Checking for remaining gaps');

  if (!review.issues || review.issues.length === 0) {
    log('gap-fill', 'No gaps to fill');
    return improvedContent;
  }

  const prompt = `Fix the issues identified in the review of this wiki page.

## Page: ${page.title}

## Issues to Fix
${review.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

## Current Content
\`\`\`mdx
${improvedContent}
\`\`\`

Fix each issue. Output the COMPLETE fixed MDX content.
Start your response with "---" (the frontmatter delimiter).`;

  const result = await runAgent(prompt, {
    model: options.improveModel || MODELS.sonnet,
    maxTokens: 16000
  });

  let fixedContent: string = result;
  if (!fixedContent.startsWith('---')) {
    const mdxMatch = result.match(/```(?:mdx)?\n([\s\S]*?)```/);
    if (mdxMatch) {
      fixedContent = mdxMatch[1];
    } else {
      fixedContent = improvedContent;
    }
  }

  fixedContent = repairFrontmatter(fixedContent);

  writeTemp(page.id, 'final.mdx', fixedContent);
  log('gap-fill', 'Complete');
  return fixedContent;
}
