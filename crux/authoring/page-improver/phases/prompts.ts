/**
 * Prompt Templates for Page Improvement Phases
 *
 * Extracted from inline strings to make prompts testable and reusable.
 */

import type { PageData, AnalysisResult, ResearchResult } from '../types.ts';

interface ImprovePromptArgs {
  page: PageData;
  filePath: string;
  importPath: string;
  directions: string;
  analysis: AnalysisResult;
  research: ResearchResult;
  objectivityContext: string;
  currentContent: string;
  entityLookup: string;
  factLookup: string | null;
  tier: string;
}

export function IMPROVE_PROMPT(args: ImprovePromptArgs): string {
  const { page, filePath, importPath, directions, analysis, research, objectivityContext, currentContent, entityLookup, factLookup, tier } = args;

  const isPolish = tier === 'polish';
  const isPersonPage = page.path?.includes('/people/') ?? false;
  const isOrgPage = page.path?.includes('/organizations/') ?? false;

  return `Improve this wiki page based on the analysis and research.

## Page Info
- ID: ${page.id}
- Title: ${page.title}
- File: ${filePath}
- Import path for components: ${importPath}

## User Directions
${directions || 'General quality improvement'}

## Analysis
${JSON.stringify(analysis, null, 2)}

## Research Sources
${JSON.stringify(research, null, 2)}
${objectivityContext}
## Current Content
\`\`\`mdx
${currentContent}
\`\`\`

## Improvement Instructions

### Content Preservation (CRITICAL)
You are EDITING an existing page, not rewriting it from scratch. Your output must preserve:
- **ALL existing sections** — do not drop, merge, or summarize away existing sections
- **ALL existing footnotes and citations** — keep every [^N] reference and its definition
- **ALL existing EntityLinks** — keep every <EntityLink> tag
- **ALL existing data tables** — keep every markdown table
- **Specific details** — dates, numbers, names, quotes must be preserved verbatim
- **Word count**: Your output should be AT LEAST as long as the input. If the current page is 3000 words, your output must be ≥3000 words.

Do NOT summarize, condense, or "streamline" existing content. Add to it. If a section is too long, leave it as-is rather than cutting it.

### Section Deduplication (CRITICAL)
Do NOT create sections that repeat content already covered elsewhere on the page. Before adding or expanding a section, check if the same information already appears in another section. Common duplication patterns to avoid:
- Research priorities listed in both a "Key Contributions" section AND a "Current Research Focus" section
- Technical challenges listed in both a "Views" section AND a "Research" section
- Career history repeated in both "Background" and a separate "Career" section
- The same quotes or facts appearing in multiple sections

If two existing sections cover the same topic, MERGE them into one section rather than keeping both.
Do NOT add thin, speculative, or padding sections. A section with only 2-3 bullet points of vague content (like "Recognition and Influence: {/* NEEDS CITATION */} has been cited") adds no value. Only add new sections if you have substantive content to put in them.

### No Editorial Meta-Comments
Do NOT add editorial meta-comments in the output like \`{/* Note: Previous version used evaluative language... */}\` or \`{/* Note: This section was restructured... */}\`. The only acceptable MDX comments are \`{/* NEEDS CITATION */}\` markers. The output should be clean wiki content, not a track-changes document.
${isPolish ? `
### Polish Tier Rules (NO RESEARCH AVAILABLE)
This is a polish-tier improvement — you have NO new research sources. Therefore:
- **DO NOT add new footnote citations** — you have no research to cite. Any new [^N] citations you add would be fabricated.
- **DO NOT invent or fabricate citation sources** — citations like "Based on statements in blog posts" or "According to presentations" without specific URLs are hallucinated.
- **KEEP all existing citations exactly as they are** — do not renumber, modify, or remove existing footnotes.
- You MAY fix formatting, improve prose clarity, add EntityLinks, fix escaping, and restructure sections.
- You MAY add factual context from the existing content (moving info between sections, adding transitions).
- If you add a NEW specific claim that needs verification, flag it with {/* NEEDS CITATION */} rather than inventing a source.
- Do NOT add {/* NEEDS CITATION */} to claims that already existed in the original content — those claims were already accepted. Only mark NEW claims you're adding.
- Use {/* NEEDS CITATION */} sparingly — at most 3-5 per page. An excess of citation markers makes the page look like an unfinished draft.
` : ''}
Make targeted improvements based on the analysis and directions. Follow these guidelines:

### Wiki Conventions
- Use GFM footnotes for prose citations: [^1], [^2], etc.
- Use inline links in tables: [Source Name](url)
- EntityLinks use **numeric IDs**: \`<EntityLink id="E22">Anthropic</EntityLink>\`
- Escape dollar signs: \\$100M not $100M
- Import from: '${importPath}'
- Use \`<F e="entity" f="hashId">display</F>\` for canonical fact values (hover tooltip shows source/date). Fact IDs are 8-char hex hashes — always copy from the Fact Lookup Table below.
- Use \`<Calc expr="{entity.hashId} / {entity.hashId}" precision={1} suffix="x" />\` for derived values (ratios, multiples, percentages)
  - Supports: +, -, *, /, ^, (). Formats: "currency", "percent", "number", or auto.
  - Prefer \`<Calc>\` over hardcoded derived numbers — it stays in sync when source facts update

### Entity Lookup Table

Use the numeric IDs below when writing EntityLinks. The format is: E## = slug → "Display Name"
ONLY use IDs from this table. If an entity is not listed here, use plain text instead.

\`\`\`
${entityLookup}
\`\`\`
${factLookup ? `
### Fact Lookup Table

These canonical facts are available for wrapping with \`<F>\`. The format is: entity.hashId: "display value" [measure] (as of date) — note.
Fact IDs are 8-char hex hashes. ONLY use IDs from this table. If a value doesn't match a fact here, leave it as plain text.

When you encounter a hardcoded number in the prose that matches a fact below, wrap it:
- Before: \`Anthropic raised \\$30 billion\`
- After: \`Anthropic raised <F e="anthropic" f="5b0663a0">\\$30 billion</F>\`

**Important:** Only wrap a value when the prose is clearly referring to the same thing the fact describes. For example, "\\$1B" could be revenue OR investment — check the fact's note to confirm the semantic match. When in doubt, leave it unwrapped.

\`\`\`
${factLookup}
\`\`\`
` : ''}
### Quality Standards
- Add citations from the research sources
- Replace vague claims with specific numbers; use \`<F>\` for canonical facts and \`<Calc>\` for derived values
- When a page has hardcoded ratios/multiples (e.g. "≈27x revenue"), replace with \`<Calc expr="{a.valuation} / {a.revenue}" precision={0} suffix="x" />\`
- Add EntityLinks for related concepts (using E## IDs from the lookup table above)
- Ensure tables have source links
- **NEVER use vague citations** like "Interview", "Earnings call", "Conference talk", "Reports", "Various"
- Always specify: exact source name, date, and context (e.g., "Tesla Q4 2021 earnings call", "MIT Aeronautics Symposium (Oct 2014)")

### Objectivity & Neutrality (CRITICAL)
Write in **encyclopedic/analytical tone**, not advocacy or journalism. This is a wiki, not an opinion piece.

**Language rules:**
- NEVER use evaluative adjectives: "remarkable", "unprecedented", "formidable", "alarming", "troubling", "devastating"
- NEVER use "represents a [judgment]" framing (e.g., "represents a complete failure") — state what happened: "none of the 150 bills passed"
- NEVER use "proved [judgment]" (e.g., "proved decisive") — describe the evidence: "lobbying spending correlated with bill defeat"
- NEVER use evaluative labels in tables: "Concerning", "Inadequate", "Weak", "Poor" — use data: "25 departures from 3,000 staff (0.8%)"
- NEVER use dramatic characterizations: "complete failure", "total collapse", "unprecedented crisis"
- Avoid "watershed", "groundbreaking", "pioneering", "game-changing" — describe the specific innovation

**Framing rules:**
- Present competing perspectives with equal analytical depth — if you explain criticism, also explain the defense
- When describing policy outcomes, use neutral language: "did not pass" not "failed"; "modified" not "weakened"
- Attribute opinions explicitly: "Critics argue..." / "Proponents contend..." — never present one side as obvious truth
- For uncertain claims, always use hedging: "evidence suggests", "approximately", "estimated at"
- When citing a source with known ideological positioning, note it: "according to [X], a [conservative/progressive/industry] think tank"

**Assessment tables:**
- Use quantitative labels: "3 of 8 commitments met (38%)" not "Poor compliance"
- Use trend descriptions: "Down 15% YoY" not "Declining"
- If you must use qualitative labels, define the methodology: "Based on [criteria], rated [level]"

### Source Integration
- When integrating research, note source credibility: think tank positioning, potential conflicts of interest
- For contested claims, cite sources from multiple perspectives
- Distinguish between primary sources (government documents, company filings) and secondary analysis (news, blogs)
- Weight primary sources over secondary; peer-reviewed over journalism

### Biographical Accuracy (CRITICAL for person/org pages)
People and organizations are VERY sensitive to inaccuracies. Real people read these pages and are embarrassed/upset by errors.
- **NEVER add biographical facts from your training data** — only from research sources or existing cited content
- **NEVER guess dates**: If you don't have a source for when someone joined/left/founded something, don't add or change dates
- **NEVER embellish**: Don't add phrases like "demonstrated exceptional X" or "known for Y" without a specific source
- **NEVER invent statistics**: Citation counts, visitor numbers, funding amounts must come from cited sources
- **NEVER attribute views without sources**: Don't say "X believes..." — say "X stated in [source]..."
- **NEVER mix up who said what**: When paraphrasing debates/forecasts, double-check which claims belong to which person
- **Remove flattery**: Replace "prominent researcher", "exceptional track record", "competitive excellence" with neutral factual descriptions
- **Prefer omission over hallucination**: A shorter accurate page is better than a longer one with errors
- **Every specific claim needs a citation**: dates, roles, numbers, quotes, achievements — if unsourced, flag or remove
- **Link citations directly**: When a footnote is just a URL, consider using an inline link instead of a footnote that redirects
- **Real-world hallucination examples** (from actual subject feedback on wiki person pages):
  - WRONG: "cited 129 times" (actual: 1,104) — never guess citation/stat numbers
  - WRONG: "joined in 2023" (actual: 2022) — never guess employment dates
  - WRONG: "known for openness to critique and technical rigor" — hallucinated characterization
  - WRONG: Citing someone's LW profile page instead of a specific post — link to the actual evidence
  - WRONG: "demonstrated exceptional forecasting accuracy" — flattery, describe specific results
  - WRONG: Confusing Person A's forecast with Person B's — verify who said what
  - WRONG: "Prominent AI researcher" for someone who is a forecaster — use accurate role descriptions
  - WRONG: "forfeited equity" when it was "tried to forfeit but equity wasn't taken away" — get details right
  - WRONG: Sections like "Other Research Contributions" that pad with low-value content — prefer focused accuracy

### Required Page Structure
${isPersonPage ? `
**Person pages MUST include these sections in order:**
1. **Quick Assessment** (right after frontmatter/imports/DataInfoBox) — a summary table:
   \`\`\`
   ## Quick Assessment

   | Aspect | Assessment |
   |--------|-----------|
   | **Primary Role** | [Current role/title and affiliation] |
   | **Key Contributions** | [1-2 sentence summary of major contributions] |
   | **Key Publications** | [Most important publications with dates] |
   | **Institutional Affiliation** | [Current employer/institution] |
   | **Influence on AI Safety** | [How their work relates to AI safety, if applicable] |
   \`\`\`
   Adapt the rows to fit the person — not all rows apply to every person. Use EntityLinks where appropriate.
   If a Quick Assessment table already exists, keep and improve it rather than removing it.

2. **Overview** — a 1-3 paragraph narrative introduction summarizing the person's significance and key achievements. This is NOT the same as "Background" — Overview is a high-level summary, Background covers career details.

3. **Background** / **Professional Background** — career history, education, positions held.

4. Additional sections as appropriate (Key Contributions, Positions and Views, Criticism, etc.)
` : isOrgPage ? `
**Organization pages MUST include an Overview section** as the first content section (after imports/DataInfoBox). The Overview should be a 1-3 paragraph narrative summary of the organization's mission, significance, and key activities.
` : `
**All pages should include an Overview section** as the first content section when the page is long enough to warrant one (>500 words). The Overview should be a concise narrative summary.
`}
If the page currently starts with "## Background" but has no "## Overview", add an Overview section BEFORE Background. Do not rename Background to Overview — they serve different purposes.

### Bare URLs
Convert any bare URLs in prose (like \`neelnanda.io\` or \`https://example.com\`) to markdown links: \`[neelnanda.io](https://neelnanda.io)\`. URLs inside footnote definitions and existing markdown links should be left as-is.

### Related Pages (DO NOT INCLUDE)
Do NOT include "## Related Pages", "## See Also", or "## Related Content" sections.
These are now rendered automatically by the RelatedPages React component at build time.
Remove any existing such sections from the content. Also remove any <Backlinks> component
usage and its import if no other usage remains.

### Frontmatter Rules
- Do NOT add a \`metrics:\` block (wordCount, citations, tables, diagrams) — these are computed at build time.
- Do NOT remove or change the \`quality:\` field — it is managed by a separate grading pipeline.

### Output Format
Output the COMPLETE improved MDX file content. Include all frontmatter and content.
Do not output markdown code blocks - output the raw MDX directly.

Start your response with "---" (the frontmatter delimiter).`;
}
