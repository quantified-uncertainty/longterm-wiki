/**
 * Adversarial Review Phase
 *
 * A dedicated reviewer model that asks specific diagnostic questions about
 * the synthesized content — separate from the synthesis model so it cannot
 * simply defend its own output.
 *
 * Diagnostic checks:
 *  1. Fact density   — paragraphs with zero specific facts
 *  2. Speculation    — claims without cited sources
 *  3. Missing data   — standard data absent for this page type
 *  4. Redundancy     — substantially duplicate sections
 *  5. Source gap     — questions a skeptical reader would ask that go unanswered
 *
 * For each gap the reviewer emits a typed re-research query (when applicable)
 * so the pipeline knows which tool to invoke.
 */

import { MODELS } from '../../../lib/anthropic.ts';
import type {
  PageData, AdversarialReviewResult, AdversarialGap, PipelineOptions,
} from '../types.ts';
import { log, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { parseAndValidate, AdversarialReviewResultSchema } from './json-parsing.ts';

// Re-export for callers that only import from adversarial-review.ts
export { AdversarialReviewResultSchema } from './json-parsing.ts';

// ── Page-type hints ───────────────────────────────────────────────────────────

const PAGE_TYPE_STANDARD_DATA: Record<string, string[]> = {
  person: ['birth year or estimated age', 'institutional affiliation', 'key publications or positions', 'educational background'],
  organization: ['founding year', 'funding sources or budget', 'staff size or key personnel', 'primary mission statement'],
  incident: ['date and timeline of events', 'actors involved', 'community reception metrics (upvotes, comments)', 'resolution or outcome'],
  concept: ['formal definition with citation', 'key proponents', 'examples or applications', 'criticisms or limitations'],
  research: ['primary finding with sample size or confidence interval', 'authors and institution', 'replication status', 'key limitation'],
};

function getPageTypeHint(page: PageData): string {
  const path = page.path.toLowerCase();
  if (path.includes('/people/')) return PAGE_TYPE_STANDARD_DATA.person.join(', ');
  if (path.includes('/organizations/')) return PAGE_TYPE_STANDARD_DATA.organization.join(', ');
  if (path.includes('/incidents/') || path.includes('/events/')) return PAGE_TYPE_STANDARD_DATA.incident.join(', ');
  if (path.includes('/research/') || path.includes('/papers/')) return PAGE_TYPE_STANDARD_DATA.research.join(', ');
  return PAGE_TYPE_STANDARD_DATA.concept.join(', ');
}

// ── Phase ─────────────────────────────────────────────────────────────────────

export async function adversarialReviewPhase(
  page: PageData,
  content: string,
  options: PipelineOptions,
): Promise<AdversarialReviewResult> {
  log('adversarial-review', 'Starting adversarial review');

  const pageTypeHint = getPageTypeHint(page);

  const prompt = `You are a skeptical research editor reviewing a draft wiki page. Your job is to find SPECIFIC, ACTIONABLE gaps — not praise what is already there.

## Page: ${page.title}
## Path: ${page.path}

## Content to Review
\`\`\`mdx
${content}
\`\`\`

## Five Diagnostic Checks

Run ALL five checks and report every gap you find.

### 1. Fact Density
Flag any paragraph that contains ZERO specific facts (numbers, dates, named people, named organizations, direct quotes, or cited URLs). Vague summaries like "many researchers believe..." or "the field has grown substantially" are red flags.
- For each flagged paragraph: quote its first sentence (to identify it) and state what type of specific fact is missing.

### 2. Speculation Detection
Flag claims that are presented as facts but are not supported by any cited source (footnote, inline URL, or <R> tag). This includes analysis, interpretation, and causal claims dressed up as established knowledge.
- For each: quote the claim and explain why it is speculative.

### 3. Missing Standard Data
For a page about "${page.title}", standard data includes: ${pageTypeHint}.
Flag each type of standard data that is MISSING or ABSENT from the page.
- For each: describe what is missing and write a targeted search query that would find it.

### 4. Redundancy
Flag any two sections that substantially cover the same ground — same facts, same angle, same conclusion — even if worded differently.
- For each pair: name the two sections and describe the overlap.

### 5. Source Gap
List the 3 most important questions a skeptical reader would ask after reading this page that the page does NOT answer. Focus on questions about verifiable facts, not matters of opinion.
- For each: state the question and write a targeted search query to answer it.

## Output Format

Output ONLY a JSON object matching this exact schema:

{
  "gaps": [
    {
      "type": "fact-density" | "speculation" | "missing-standard-data" | "redundancy" | "source-gap",
      "description": "specific description of the gap",
      "reResearchQuery": "targeted search query to fill this gap (omit for redundancy/edit-only gaps)",
      "actionType": "re-research" | "edit" | "none"
    }
  ],
  "needsReResearch": true | false,
  "reResearchQueries": ["query 1", "query 2"],
  "overallAssessment": "1-2 sentence summary of the most important gaps"
}

Rules:
- "re-research" = a targeted web/SCRY search can fill this gap with verifiable data
- "edit" = can be fixed without new sources (merge sections, remove speculation, rephrase)
- "none" = advisory, no action required
- reResearchQueries must be the flat union of all reResearchQuery fields where actionType === "re-research"
- If there are NO gaps, return { "gaps": [], "needsReResearch": false, "reResearchQueries": [], "overallAssessment": "Page meets quality standards." }`;

  const result = await runAgent(prompt, {
    model: options.adversarialModel || MODELS.sonnet,
    maxTokens: 6000,
  });

  const review = parseAndValidate<AdversarialReviewResult>(
    result,
    AdversarialReviewResultSchema,
    'adversarial-review',
    (raw, error) => ({
      gaps: [],
      needsReResearch: false,
      reResearchQueries: [],
      overallAssessment: 'Could not parse adversarial review output.',
      raw,
      error,
    }),
  );

  // Normalize: ensure needsReResearch and reResearchQueries are derived from gaps,
  // not trusted from the LLM (which may have summarized them incorrectly).
  const reSearchGaps = review.gaps.filter(
    (g: AdversarialGap) => g.actionType === 're-research' && g.reResearchQuery,
  );
  review.needsReResearch = reSearchGaps.length > 0;
  review.reResearchQueries = reSearchGaps.map((g: AdversarialGap) => g.reResearchQuery as string);

  // Log summary
  const gapsByType = review.gaps.reduce((acc: Record<string, number>, g: AdversarialGap) => {
    acc[g.type] = (acc[g.type] || 0) + 1;
    return acc;
  }, {});
  const gapSummary = Object.entries(gapsByType)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');

  log('adversarial-review', `Complete — ${review.gaps.length} gaps found (${gapSummary || 'none'})`);
  log('adversarial-review', `Needs re-research: ${review.needsReResearch}`);
  if (review.overallAssessment) {
    log('adversarial-review', `Assessment: ${review.overallAssessment}`);
  }

  writeTemp(page.id, 'adversarial-review.json', review);
  return review;
}
