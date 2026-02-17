/**
 * Review Phase
 *
 * Reviews improved content for quality and wiki convention compliance.
 */

import { MODELS } from '../../../lib/anthropic.ts';
import type { PageData, ReviewResult, PipelineOptions } from '../types.ts';
import { log, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { parseJsonFromLlm } from './json-parsing.ts';

export async function reviewPhase(page: PageData, improvedContent: string, options: PipelineOptions): Promise<ReviewResult> {
  log('review', 'Starting review');

  const prompt = `Review this improved wiki page for quality and wiki conventions.

## Page: ${page.title}

## Improved Content
\`\`\`mdx
${improvedContent}
\`\`\`

## Review Checklist

Check for:
1. **Frontmatter**: Valid YAML, required fields present
2. **Dollar signs**: All escaped as \\$ (not raw $)
3. **Comparisons**: No <NUMBER patterns (use "less than")
4. **EntityLinks**: Properly formatted with valid IDs
5. **Citations**: Mix of footnotes (prose) and inline links (tables)
6. **Tables**: Properly formatted markdown tables
7. **Components**: Imports match usage
8. **Objectivity**: No evaluative adjectives ("remarkable", "unprecedented"), no "represents a [judgment]" framing, no evaluative table labels ("Concerning", "Weak"), competing perspectives given equal depth, opinions attributed to specific actors
9. **Section duplication**: Flag if two sections cover substantially the same topic (e.g., an org described under both "## Organization Name" and "## Organization Programs"). Also flag if the same fact/quote/statistic is repeated in multiple sections.
10. **Structure (person pages)**: Person pages must have "## Quick Assessment" (summary table) and "## Overview" (narrative intro) before "## Background". Flag if missing.
11. **Bare URLs**: Flag any URLs in prose not wrapped in markdown link syntax (e.g., bare "example.com" instead of "[example.com](https://example.com)")

Output a JSON review:
{
  "valid": true/false,
  "issues": ["issue 1", "issue 2"],
  "objectivityIssues": ["specific objectivity problem 1"],
  "suggestions": ["optional improvement 1"],
  "qualityScore": 70-100
}

Output ONLY valid JSON.`;

  const result = await runAgent(prompt, {
    model: options.reviewModel || MODELS.sonnet,
    maxTokens: 4000
  });

  const review = parseJsonFromLlm<ReviewResult>(result, 'review', (raw) => ({
    valid: true,
    issues: [],
    raw,
  }));

  writeTemp(page.id, 'review.json', review);
  log('review', `Complete (valid: ${review.valid}, issues: ${review.issues?.length || 0})`);
  return review;
}
