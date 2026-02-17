/**
 * Pipeline phases for the page-improver.
 *
 * Each function implements one phase of the improvement pipeline:
 * analyze, research, improve, review, validate, gap-fill, triage.
 */

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { MODELS } from '../../lib/anthropic.ts';
import { buildEntityLookupForContent } from '../../lib/entity-lookup.ts';
import { buildFactLookupForContent } from '../../lib/fact-lookup.ts';
import { convertSlugsToNumericIds } from '../creator/deployment.ts';
import type {
  PageData, AnalysisResult, ResearchResult, ReviewResult,
  ValidationResult, PipelineOptions, TriageResult,
} from './types.ts';
import {
  ROOT, NODE_TSX, CRITICAL_RULES, QUALITY_RULES, log,
  getFilePath, getImportPath, writeTemp, loadPages,
  repairFrontmatter, stripRelatedPagesSections, buildObjectivityContext,
} from './utils.ts';
import { runAgent, executeWebSearch, executeScrySearch } from './api.ts';

// ── Analyze Phase ────────────────────────────────────────────────────────────

export async function analyzePhase(page: PageData, directions: string, options: PipelineOptions): Promise<AnalysisResult> {
  log('analyze', 'Starting analysis');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const prompt = `Analyze this wiki page for improvement opportunities.

## Page Info
- ID: ${page.id}
- Title: ${page.title}
- Quality: ${page.quality || 'N/A'}
- Importance: ${page.readerImportance || 'N/A'}
- Path: ${filePath}

## User-Specified Directions
${directions || 'No specific directions provided - do a general quality improvement.'}

## Current Content
\`\`\`mdx
${currentContent}
\`\`\`

## Analysis Required

Analyze the page and output a JSON object with:

1. **currentState**: Brief assessment of the page's current quality
2. **gaps**: Array of specific content gaps or issues
3. **researchNeeded**: Array of specific topics to research (for SCRY/web search)
4. **improvements**: Array of specific improvements to make, prioritized
5. **entityLinks**: Array of entity IDs that should be linked but aren't
6. **citations**: Assessment of citation quality (count, authoritative sources, gaps)
7. **objectivityIssues**: Array of specific objectivity/neutrality problems found (loaded language, evaluative labels, asymmetric framing, missing counterarguments, advocacy-adjacent tone)

Focus especially on the user's directions: "${directions || 'general improvement'}"

Output ONLY valid JSON, no markdown code blocks.`;

  const result = await runAgent(prompt, {
    model: options.analysisModel || MODELS.sonnet,
    maxTokens: 4000
  });

  let analysis: AnalysisResult;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('analyze', `Warning: Could not parse analysis as JSON: ${error.message}`);
    analysis = { raw: result, error: error.message };
  }

  writeTemp(page.id, 'analysis.json', analysis);
  log('analyze', 'Complete');
  return analysis;
}

// ── Research Phase ───────────────────────────────────────────────────────────

export async function researchPhase(page: PageData, analysis: AnalysisResult, options: PipelineOptions): Promise<ResearchResult> {
  log('research', 'Starting research');

  const topics: string[] = analysis.researchNeeded || [];
  if (topics.length === 0) {
    log('research', 'No research topics identified, skipping');
    return { sources: [] };
  }

  const prompt = `Research the following topics to improve a wiki page about "${page.title}".

## Topics to Research
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## Research Instructions

For each topic:
1. Search SCRY (EA Forum/LessWrong) for relevant discussions
2. Search the web for authoritative sources

Use the tools provided to search. For each source found, extract:
- Title
- URL
- Author (if available)
- Date (if available)
- Key facts or quotes relevant to the topic

After researching, output a JSON object with:
{
  "sources": [
    {
      "topic": "which research topic this addresses",
      "title": "source title",
      "url": "source URL",
      "author": "author name",
      "date": "publication date",
      "facts": ["key fact 1", "key fact 2"],
      "relevance": "high/medium/low"
    }
  ],
  "summary": "brief summary of what was found"
}

Output ONLY valid JSON at the end.`;

  const tools = options.deep ? [
    {
      name: 'scry_search',
      description: 'Search EA Forum and LessWrong posts via SCRY',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          table: { type: 'string', enum: ['mv_eaforum_posts', 'mv_lesswrong_posts'], default: 'mv_eaforum_posts' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ] : [
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ];

  const result = await runAgent(prompt, {
    model: options.researchModel || MODELS.sonnet,
    maxTokens: 8000,
    tools
  });

  let research: ResearchResult;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    research = jsonMatch ? JSON.parse(jsonMatch[0]) : { sources: [], raw: result };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('research', `Warning: Could not parse research as JSON: ${error.message}`);
    research = { sources: [], raw: result, error: error.message };
  }

  writeTemp(page.id, 'research.json', research);
  log('research', `Complete (${research.sources?.length || 0} sources found)`);
  return research;
}

// ── Improve Phase ────────────────────────────────────────────────────────────

export async function improvePhase(page: PageData, analysis: AnalysisResult, research: ResearchResult, directions: string, options: PipelineOptions): Promise<string> {
  log('improve', 'Starting improvements');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');
  const importPath = getImportPath();

  const objectivityContext = buildObjectivityContext(page, analysis);

  log('improve', 'Building entity lookup table...');
  const entityLookup = buildEntityLookupForContent(currentContent, ROOT);
  const entityLookupCount = entityLookup.split('\n').filter(Boolean).length;
  log('improve', `  Found ${entityLookupCount} relevant entities for lookup`);

  log('improve', 'Building fact lookup table...');
  const factLookup = buildFactLookupForContent(page.id, currentContent, ROOT);
  const factLookupCount = factLookup ? factLookup.split('\n').filter(l => l && !l.startsWith('#')).length : 0;
  log('improve', `  Found ${factLookupCount} available facts for wrapping`);

  const prompt = `Improve this wiki page based on the analysis and research.

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
- Use \`<F e="entity" f="fact-id">display</F>\` for canonical fact values (hover tooltip shows source/date)
- Use \`<Calc expr="{entity.factId} / {entity.factId}" precision={1} suffix="x" />\` for derived values (ratios, multiples, percentages)
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

These canonical facts are available for wrapping with \`<F>\`. The format is: entity.factId: "display value" (as of date) — note.
ONLY use fact IDs from this table. If a value doesn't match a fact here, leave it as plain text.

When you encounter a hardcoded number in the prose that matches a fact below, wrap it:
- Before: \`Anthropic raised \\$30 billion\`
- After: \`Anthropic raised <F e="anthropic" f="series-g-raise">\\$30 billion</F>\`

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

  const result = await runAgent(prompt, {
    model: options.improveModel || MODELS.sonnet,
    maxTokens: 16000
  });

  let improvedContent: string = result;
  if (!improvedContent.startsWith('---')) {
    const mdxMatch = result.match(/```(?:mdx)?\n([\s\S]*?)```/);
    if (mdxMatch) {
      improvedContent = mdxMatch[1];
    }
  }

  // Update lastEdited in frontmatter
  const today = new Date().toISOString().split('T')[0];
  improvedContent = improvedContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`
  );

  improvedContent = repairFrontmatter(improvedContent);
  improvedContent = stripRelatedPagesSections(improvedContent);

  const { content: convertedContent, converted: slugsConverted } = convertSlugsToNumericIds(improvedContent, ROOT);
  if (slugsConverted > 0) {
    log('improve', `  Converted ${slugsConverted} remaining slug-based EntityLink ID(s) to E## format`);
    improvedContent = convertedContent;
  }

  writeTemp(page.id, 'improved.mdx', improvedContent);
  log('improve', 'Complete');
  return improvedContent;
}

// ── Review Phase ─────────────────────────────────────────────────────────────

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

  let review: ReviewResult;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    review = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('review', `Warning: Could not parse review as JSON: ${error.message}`);
    review = { valid: true, issues: [], raw: result };
  }

  writeTemp(page.id, 'review.json', review);
  log('review', `Complete (valid: ${review.valid}, issues: ${review.issues?.length || 0})`);
  return review;
}

// ── Validate Phase ───────────────────────────────────────────────────────────

export async function validatePhase(page: PageData, improvedContent: string, _options: PipelineOptions): Promise<ValidationResult> {
  log('validate', 'Running validation checks...');

  const filePath = getFilePath(page.path);
  const originalContent = fs.readFileSync(filePath, 'utf-8');
  let fixedContent = improvedContent;

  // Write improved content to the actual file so validators check the new version
  fs.writeFileSync(filePath, improvedContent);

  const issues: { critical: Array<{ rule: string; count?: number; output?: string; error?: string }>; quality: Array<{ rule: string; count?: number; output?: string; error?: string }> } = {
    critical: [],
    quality: []
  };

  try {
    // Run critical rules
    for (const rule of CRITICAL_RULES) {
      try {
        const result = execSync(
          `${NODE_TSX} crux/crux.mjs validate unified --rules=${rule} --ci 2>&1 | grep -i "${page.id}" || true`,
          { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }
        );
        const errorCount = (result.match(/error/gi) || []).length;
        if (errorCount > 0) {
          issues.critical.push({ rule, count: errorCount, output: result.trim() });
          log('validate', `  x ${rule}: ${errorCount} error(s)`);
        } else {
          log('validate', `  ok ${rule}`);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('validate', `  ? ${rule}: check failed — ${error.message?.slice(0, 100)}`);
      }
    }

    // Run quality rules
    for (const rule of QUALITY_RULES) {
      try {
        const result = execSync(
          `${NODE_TSX} crux/crux.mjs validate unified --rules=${rule} --ci 2>&1 | grep -i "${page.id}" || true`,
          { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }
        );
        const warningCount = (result.match(/warning/gi) || []).length;
        if (warningCount > 0) {
          issues.quality.push({ rule, count: warningCount, output: result.trim() });
          log('validate', `  warn ${rule}: ${warningCount} warning(s)`);
        } else {
          log('validate', `  ok ${rule}`);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('validate', `  ? ${rule}: quality check failed — ${error.message?.slice(0, 100)}`);
      }
    }

    // Validate EntityLink IDs against known pages/entities
    log('validate', 'Checking EntityLink IDs against registry...');
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const entityLinkIds = [...fileContent.matchAll(/<EntityLink\s+id="([^"]+)"/g)].map(m => m[1]);
      if (entityLinkIds.length > 0) {
        const pages = loadPages();
        const pageIds = new Set(pages.map(p => p.id));

        let idRegistry: Record<string, string> = {};
        try {
          const raw = fs.readFileSync(path.join(ROOT, 'data/id-registry.json'), 'utf-8');
          idRegistry = JSON.parse(raw).entities || {};
        } catch { /* ignore */ }

        const invalidIds = entityLinkIds.filter(id => {
          if (/^E\d+$/i.test(id)) {
            const slug = idRegistry[id.toUpperCase()];
            return !slug;
          }
          return !pageIds.has(id);
        });
        if (invalidIds.length > 0) {
          const uniqueInvalid = [...new Set(invalidIds)];
          issues.quality.push({
            rule: 'entitylink-registry',
            count: uniqueInvalid.length,
            output: `EntityLink IDs not found in pages registry: ${uniqueInvalid.join(', ')}`
          });
          log('validate', `  warn entitylink-registry: ${uniqueInvalid.length} unresolved ID(s): ${uniqueInvalid.join(', ')}`);
        } else {
          log('validate', `  ok entitylink-registry (${entityLinkIds.length} links verified)`);
        }
      } else {
        log('validate', '  ok entitylink-registry (no EntityLinks)');
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('validate', `  ? entitylink-registry: check failed — ${error.message?.slice(0, 100)}`);
    }

    // Auto-fix escaping and formatting issues
    log('validate', 'Running auto-fixes (escaping, markdown)...');
    try {
      execSync(
        `${NODE_TSX} crux/crux.mjs fix escaping 2>&1`,
        { cwd: ROOT, encoding: 'utf-8', timeout: 60000 }
      );
      execSync(
        `${NODE_TSX} crux/crux.mjs fix markdown 2>&1`,
        { cwd: ROOT, encoding: 'utf-8', timeout: 60000 }
      );
      fixedContent = fs.readFileSync(filePath, 'utf-8');
      log('validate', '  ok auto-fixes applied');
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('validate', `  warn auto-fix failed: ${error.message?.slice(0, 100)}`);
    }

    // Check MDX compilation
    log('validate', 'Checking MDX compilation...');
    try {
      execSync(`${NODE_TSX} crux/crux.mjs validate compile --quick`, {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 60000
      });
      log('validate', '  ok MDX compiles');
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      issues.critical.push({ rule: 'compile', error: `MDX compilation failed: ${error.message?.slice(0, 200)}` });
      log('validate', `  x MDX compilation failed: ${error.message?.slice(0, 100)}`);
    }
  } finally {
    // Restore original content
    fs.writeFileSync(filePath, originalContent);
  }

  writeTemp(page.id, 'validation-results.json', issues);

  const hasCritical: boolean = issues.critical.length > 0;
  log('validate', `Complete (critical: ${issues.critical.length}, quality: ${issues.quality.length})`);

  return { issues, hasCritical, improvedContent: fixedContent };
}

// ── Gap Fill Phase ───────────────────────────────────────────────────────────

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

// ── Triage Phase ─────────────────────────────────────────────────────────────

export async function triagePhase(page: PageData, lastEdited: string): Promise<TriageResult> {
  log('triage', `Checking for news since ${lastEdited}: "${page.title}"`);

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const contentAfterFm = currentContent.replace(/^---[\s\S]*?---\n/, '');
  const contentPreview = contentAfterFm.slice(0, 500);

  const searchQuery = `${page.title} developments news ${lastEdited} to ${new Date().toISOString().slice(0, 10)}`;
  const scryQuery = page.title;

  const [webResults, scryResults] = await Promise.all([
    executeWebSearch(searchQuery).catch(err => `Web search failed: ${err.message}`),
    executeScrySearch(scryQuery).catch(err => `SCRY search failed: ${err.message}`),
  ]);

  const classificationPrompt = `You are triaging whether a wiki page needs updating.

## Page
- Title: ${page.title}
- ID: ${page.id}
- Last edited: ${lastEdited}
- Content preview: ${contentPreview}

## Recent Web Results
${webResults}

## Recent EA Forum / LessWrong Results (SCRY)
${scryResults}

## Task

Based on the search results, determine if there are significant new developments since ${lastEdited} that warrant updating this page.

Classify into one of these tiers:

- **skip**: No meaningful new developments found. Page content is still current.
- **polish**: Minor updates only — small corrections, formatting, or very minor new info. (~$2-3)
- **standard**: Notable new developments that should be added — new papers, policy changes, funding rounds, etc. (~$5-8)
- **deep**: Major developments requiring thorough research — new organizations, paradigm shifts, major incidents, etc. (~$10-15)

Output ONLY a JSON object:
{
  "recommendedTier": "skip|polish|standard|deep",
  "reason": "1-2 sentence explanation of why this tier",
  "newDevelopments": ["list", "of", "specific", "new", "developments", "found"]
}`;

  const result = await runAgent(classificationPrompt, {
    model: MODELS.haiku,
    maxTokens: 1000,
  });

  let parsed: { recommendedTier: string; reason: string; newDevelopments: string[] };
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result);
  } catch {
    log('triage', 'Warning: Could not parse triage result, defaulting to standard');
    parsed = { recommendedTier: 'standard', reason: 'Triage parsing failed, using default', newDevelopments: [] };
  }

  const validTiers: string[] = ['skip', 'polish', 'standard', 'deep'];
  const tier = (validTiers.includes(parsed.recommendedTier)
    ? parsed.recommendedTier
    : 'standard') as TriageResult['recommendedTier'];

  const costMap = { skip: '$0', polish: '$2-3', standard: '$5-8', deep: '$10-15' };

  const triageResult: TriageResult = {
    pageId: page.id,
    title: page.title,
    lastEdited,
    recommendedTier: tier,
    reason: parsed.reason || '',
    newDevelopments: parsed.newDevelopments || [],
    estimatedCost: costMap[tier],
    triageCost: '~$0.08',
  };

  writeTemp(page.id, 'triage.json', triageResult);
  log('triage', `Result: ${tier} — ${parsed.reason}`);
  return triageResult;
}
