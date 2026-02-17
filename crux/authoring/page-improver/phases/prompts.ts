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
}

export function IMPROVE_PROMPT(args: ImprovePromptArgs): string {
  const { page, filePath, importPath, directions, analysis, research, objectivityContext, currentContent, entityLookup } = args;

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

Make targeted improvements based on the analysis and directions. Follow these guidelines:

### Wiki Conventions
- Use GFM footnotes for prose citations: [^1], [^2], etc.
- Use inline links in tables: [Source Name](url)
- EntityLinks use **numeric IDs**: \`<EntityLink id="E22">Anthropic</EntityLink>\`
- Escape dollar signs: \\$100M not $100M
- Import from: '${importPath}'

### Entity Lookup Table

Use the numeric IDs below when writing EntityLinks. The format is: E## = slug → "Display Name"
ONLY use IDs from this table. If an entity is not listed here, use plain text instead.

\`\`\`
${entityLookup}
\`\`\`

### Quality Standards
- Add citations from the research sources
- Replace vague claims with specific numbers
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
