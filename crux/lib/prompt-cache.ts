/**
 * Prompt Caching Utilities
 *
 * Anthropic's prompt caching uses `cache_control` blocks on the system prompt.
 * When the same system prompt prefix is sent within 5 minutes, cached input
 * tokens are billed at 90% discount (0.1x price). The first request pays a 25%
 * premium on the cached portion for cache writes.
 *
 * Strategy: split the system prompt into a static prefix (wiki conventions,
 * objectivity rules, biographical accuracy rules — the same for every page)
 * and a dynamic suffix (page-specific content, entity lookups, KB facts).
 * Mark the static prefix with cache_control: { type: "ephemeral" }.
 *
 * Usage:
 *   import { buildCachedSystemPrompt } from './prompt-cache.ts';
 *
 *   const system = buildCachedSystemPrompt(staticGuidelines, dynamicContext);
 *   // Pass `system` as the `system` parameter to Anthropic API
 */

import type Anthropic from '@anthropic-ai/sdk';

type TextBlockParam = Anthropic.Messages.TextBlockParam;

/**
 * Build a system prompt with cache_control on the static prefix.
 *
 * The Anthropic API accepts `system` as either a string or an array of
 * content blocks. When prompt caching is desired, we use the array form
 * and mark the static portion with `cache_control: { type: "ephemeral" }`.
 *
 * @param staticPrefix - Guidelines that are identical across all pages
 *   (wiki conventions, objectivity rules, etc.). Cached after first call.
 * @param dynamicSuffix - Page-specific content (entity lookup, KB facts,
 *   current content, etc.). Never cached.
 * @returns Array of TextBlockParam suitable for the `system` parameter
 */
export function buildCachedSystemPrompt(
  staticPrefix: string,
  dynamicSuffix: string,
): TextBlockParam[] {
  const blocks: TextBlockParam[] = [];

  if (staticPrefix) {
    blocks.push({
      type: 'text',
      text: staticPrefix,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (dynamicSuffix) {
    blocks.push({
      type: 'text',
      text: dynamicSuffix,
    });
  }

  return blocks;
}

/**
 * Extract the static (cacheable) portion of the IMPROVE_PROMPT.
 *
 * The improve prompt has a consistent structure:
 * 1. Page Info (dynamic)
 * 2. User Directions (dynamic)
 * 3. Analysis (dynamic)
 * 4. Research Sources (dynamic)
 * 5. Current Content (dynamic)
 * 6. Improvement Instructions — subdivided into:
 *    a. Content Preservation rules (STATIC)
 *    b. Section Deduplication rules (STATIC)
 *    c. Wiki Conventions (STATIC)
 *    d. Quality Standards (STATIC)
 *    e. Objectivity & Neutrality (STATIC)
 *    f. Biographical Accuracy (STATIC)
 *    g. Entity Lookup Table (dynamic)
 *    h. KB Facts (dynamic)
 *    i. Template requirements (dynamic)
 *
 * We cache the static instruction sections as the system prompt,
 * and put the dynamic page content into the user message.
 */

/**
 * Static improvement guidelines that are identical across all page improvements.
 * These are extracted from IMPROVE_PROMPT and cached via prompt caching.
 *
 * Note: page-type-specific rules (person, org, historical) and tier-specific
 * rules (polish constraints) are NOT included here because they vary per page.
 * Only the truly universal rules are cached.
 */
export const STATIC_IMPROVE_GUIDELINES = `## Improvement Instructions

### Content Preservation (CRITICAL)
You are EDITING an existing page, not rewriting it from scratch. Your output must preserve:
- **ALL existing sections** — do not drop, merge, or summarize away existing sections
- **ALL existing footnotes and citations** — keep every [^N] reference and its definition. If you remove an inline reference [^N], also remove its definition. Do not leave orphaned footnote definitions.
- **ALL existing EntityLinks** — keep every <EntityLink> tag
- **ALL existing data tables** — keep every markdown table
- **Specific details** — dates, numbers, names, quotes must be preserved verbatim
- **Word count**: Your output should be AT LEAST as long as the input. If the current page is 3000 words, your output must be >=3000 words.

Do NOT summarize, condense, or "streamline" existing content. Add to it. If a section is too long, leave it as-is rather than cutting it.

### Section Deduplication (CRITICAL)
Do NOT create sections that repeat content already covered elsewhere on the page. Before adding or expanding a section, check if the same information already appears in another section. Common duplication patterns to avoid:
- Research priorities listed in both a "Key Contributions" section AND a "Current Research Focus" section
- Technical challenges listed in both a "Views" section AND a "Research" section
- Career history repeated in both "Background" and a separate "Career" section
- The same quotes or facts appearing in multiple sections
- **Quantitative stats scattered across sections**: If a stat like "40+ members" or "\\$30M in funding" is already stated in Overview, do NOT repeat it in Current State, Strategic Position, Community Building, etc.

If two existing sections cover the same topic, MERGE them into one section rather than keeping both.
Do NOT add thin, speculative, or padding sections. A section with only 2-3 bullet points of vague content adds no value. Only add new sections if you have substantive content to put in them.

### Avoid Redundant Link/Resource Tables
Do NOT generate "Sources & Resources", "Primary Sources", "Key Research Areas", "Related Organizations", or "Additional Resources" tables at the end of the page. These duplicate the inline footnote citations. If the page already has 10+ inline citations, omit these tables entirely. A short "## External Links" section with 3-5 key URLs is acceptable.

### No Editorial Meta-Comments
Do NOT add editorial meta-comments like \`{/* Note: Previous version used evaluative language... */}\`. The only acceptable MDX comments are \`{/* NEEDS CITATION */}\` markers.

### Wiki Conventions
- Use GFM footnotes for prose citations: [^1], [^2], etc. (numbered footnotes will be auto-converted to DB-driven [^rc-XXXX] format by the pipeline)
- Use inline links in tables: [Source Name](url)
- EntityLinks use **wiki IDs**: \`<EntityLink id="E22">Anthropic</EntityLink>\`
- Escape dollar signs: \\\\\\$100M not \\$100M

### Quality Standards
- Add citations from the research sources
- Replace vague claims with specific numbers
- Add EntityLinks for related concepts (using E## IDs from the lookup table)
- Ensure tables have source links
- **NEVER use vague citations** like "Interview", "Earnings call", "Conference talk", "Reports", "Various"
- Always specify: exact source name, date, and context
- **New specific claims require sources**: Any NEW date, number, role, or attribution you add that was NOT in the original content MUST have a citation from the research sources.

### Objectivity & Neutrality (CRITICAL)
Write in **encyclopedic/analytical tone**, not advocacy or journalism. This is a wiki, not an opinion piece.

**Language rules:**
- NEVER use evaluative adjectives: "remarkable", "unprecedented", "formidable", "alarming", "troubling", "devastating"
- NEVER use "represents a [judgment]" framing — state what happened
- NEVER use "proved [judgment]" — describe the evidence
- NEVER use evaluative labels in tables: "Concerning", "Inadequate", "Weak", "Poor" — use data
- NEVER use dramatic characterizations: "complete failure", "total collapse", "unprecedented crisis"
- Avoid "watershed", "groundbreaking", "pioneering", "game-changing" — describe the specific innovation

**Framing rules:**
- Present competing perspectives with equal analytical depth
- When describing policy outcomes, use neutral language: "did not pass" not "failed"; "modified" not "weakened"
- Attribute opinions explicitly: "Critics argue..." / "Proponents contend..." — never present one side as obvious truth
- For uncertain claims, always use hedging: "evidence suggests", "approximately", "estimated at"
- When citing a source with known ideological positioning, note it

**Assessment tables:**
- Use quantitative labels: "3 of 8 commitments met (38%)" not "Poor compliance"
- Use trend descriptions: "Down 15% YoY" not "Declining"
- If you must use qualitative labels, define the methodology

### Source Integration
- When integrating research, note source credibility: think tank positioning, potential conflicts of interest
- For contested claims, cite sources from multiple perspectives
- Distinguish between primary sources (government documents, company filings) and secondary analysis (news, blogs)
- Weight primary sources over secondary; peer-reviewed over journalism

### Biographical Accuracy (CRITICAL for person/org pages)
People and organizations are VERY sensitive to inaccuracies.
- **NEVER add biographical facts from your training data** — only from research sources or existing cited content
- **NEVER guess dates**
- **NEVER embellish**
- **NEVER invent statistics**
- **NEVER attribute views without sources**
- **NEVER mix up who said what**
- **Remove flattery**
- **Prefer omission over hallucination**
- **Every specific claim needs a citation**

### Bare URLs
Convert any bare URLs in prose to markdown links. URLs inside footnote definitions and existing markdown links should be left as-is.

### Related Pages (DO NOT INCLUDE)
Do NOT include "## Related Pages", "## See Also", or "## Related Content" sections. These are rendered automatically.

### Frontmatter Rules
- Do NOT add a \`metrics:\` block — these are computed at build time.
- Do NOT change \`quality:\`, \`readerImportance:\`, \`researchImportance:\`, \`tacticalValue:\`, \`ratings:\`, \`clusters:\`, or \`balanceFlags:\` fields.
- Do NOT add new frontmatter fields that are not in the original.
- You may update \`description:\` and \`summary:\` to reflect content changes.

### Output Format
Output the COMPLETE improved MDX file content. Include all frontmatter and content.
Do not output markdown code blocks - output the raw MDX directly.

Start your response with "---" (the frontmatter delimiter).`;

/**
 * Check if a system prompt content block array uses prompt caching.
 */
export function hasCacheControl(
  system: string | TextBlockParam[] | undefined,
): boolean {
  if (!system || typeof system === 'string') return false;
  return system.some(block => block.cache_control != null);
}
