#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Grade Content Script — 3-Step Pipeline
 *
 * Grades pages using a 3-step pipeline:
 *   Step 1: Automated warnings — regex-based rules (fast, no LLM)
 *   Step 2: LLM checklist — Haiku reviews ~70 checklist items → warnings array
 *   Step 3: Rating scales — Sonnet scores 7 dimensions, informed by Steps 1-2
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node crux/authoring/grade-content.ts [options]
 *
 * Options:
 *   --page ID          Grade a single page by ID or partial match
 *   --dry-run          Show what would be processed without calling API
 *   --limit N          Only process N pages (for testing)
 *   --parallel N       Process N pages concurrently (default: 1)
 *   --category X       Only process pages in category (models, risks, responses, etc.)
 *   --skip-graded      Skip pages that already have importance set
 *   --output FILE      Write results to JSON file (default: grades-output.json)
 *   --apply            Apply grades directly to frontmatter (use with caution)
 *   --skip-warnings    Skip Steps 1-2, just rate (backward compat)
 *   --warnings-only    Run Steps 1-2, skip rating (Step 3)
 *
 * Cost estimate: ~$0.06 per page (full pipeline), ~$0.01 per page (warnings-only)
 */

import { createClient, callClaude, parseJsonResponse, MODELS } from '../lib/anthropic.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { CONTENT_DIR } from '../lib/content-types.ts';
import { ValidationEngine, ContentFile } from '../lib/validation-engine.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import {
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
} from '../lib/rules/index.ts';
import type Anthropic from '@anthropic-ai/sdk';

const OUTPUT_FILE = '.claude/temp/grades-output.json';

// Parse command line args
const args: string[] = process.argv.slice(2);

interface Options {
  page: string | null;
  dryRun: boolean;
  limit: number | null;
  category: string | null;
  skipGraded: boolean;
  output: string;
  apply: boolean;
  parallel: number;
  skipWarnings: boolean;
  warningsOnly: boolean;
}

const options: Options = {
  page: args.includes('--page') ? args[args.indexOf('--page') + 1] : null,
  dryRun: args.includes('--dry-run'),
  limit: args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null,
  category: args.includes('--category') ? args[args.indexOf('--category') + 1] : null,
  skipGraded: args.includes('--skip-graded'),
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : OUTPUT_FILE,
  apply: args.includes('--apply'),
  parallel: args.includes('--parallel') ? parseInt(args[args.indexOf('--parallel') + 1]) : 1,
  skipWarnings: args.includes('--skip-warnings'),
  warningsOnly: args.includes('--warnings-only'),
};

const SYSTEM_PROMPT: string = `You are an expert evaluator of AI safety content for a resource aimed at **expert AI prioritization work** - helping researchers and funders identify and prioritize concrete interventions to reduce AI existential risk.

Score each page on importance (0-100, one decimal place). Be discriminating - use the full range.

Also score each page on SEVEN quality dimensions (0-10 scale, one decimal). BE EXTREMELY HARSH - a 7 is exceptional, 8+ is world-class. Most wiki content should score 3-5.

**FOCUS (0-10)**: Does it answer what the title promises?
- 9-10: Perfectly laser-focused on exactly what title claims
- 7-8: Stays tightly on topic throughout (exceptional)
- 5-6: Mostly on-topic but some tangential sections
- 3-4: Drifts significantly, answers adjacent but different question
- 1-2: Almost entirely off-topic from title
- 0: Completely unrelated to title

**NOVELTY (0-10)**: How original is the content? CRITICAL: Most wiki content is compilation, not insight.
- 9-10: Groundbreaking original research, creates new field or framework (academic publication level)
- 7-8: Significant original synthesis not found elsewhere, novel insights (exceptional - very rare)
- 5-6: Genuine new framing or connections that add real insight beyond sources
- 3-4: Well-organized compilation of existing work; competent summary with minor original perspective
- 1-2: Restates common knowledge, purely derivative
- 0: No content or completely plagiarized

NOVELTY CALIBRATION (critical):
- Page that organizes known arguments into tables → 3-4 (compilation, not insight)
- Page that summarizes someone else's framework → 3 (no original contribution)
- Page that applies standard economics/game theory to known problem → 4-5
- Page with genuinely new framework or quantitative model not found elsewhere → 6-7
- DO NOT give 5-6 for "good organization" - that's a 3-4

**RIGOR (0-10)**: How well-evidenced and precise?
- 9-10: Every claim sourced to authoritative primary sources, all quantified with uncertainty ranges (journal-quality)
- 7-8: Nearly all claims well-sourced and quantified, minimal gaps (exceptional)
- 5-6: Most major claims sourced, some quantification, minor gaps
- 3-4: Mix of sourced and unsourced, vague claims common
- 1-2: Few sources, mostly assertions
- 0: No evidence

**COMPLETENESS (0-10)**: How comprehensive relative to TITLE's promise (not "has lots of content")?
- 9-10: Exhaustive coverage of exactly what title claims (textbook-level)
- 7-8: Covers all major aspects of claimed topic (exceptional)
- 5-6: Covers main points of claimed topic, some gaps
- 3-4: Missing key aspects of what title promises
- 1-2: Barely addresses claimed topic
- 0: Stub/placeholder

**CONCRETENESS (0-10)**: Specific vs. abstract?
- 9-10: Specific numbers, examples, recommendations throughout (consultant-ready)
- 7-8: Mostly concrete with specific details (exceptional)
- 5-6: Mix of concrete and abstract
- 3-4: Mostly abstract, vague generalities ("consider the tradeoffs", "it depends")
- 1-2: Almost entirely abstract hand-waving
- 0: No concrete content

**ACTIONABILITY (0-10)**: Can reader make different decisions after reading?
- 9-10: Explicit "do X not Y" with quantified tradeoffs (decision-ready)
- 7-8: Clear concrete recommendations (exceptional)
- 5-6: Some actionable takeaways
- 3-4: Implications unclear, reader must infer
- 1-2: Purely descriptive, no practical application
- 0: No actionable content

**OBJECTIVITY (0-10)**: Epistemic honesty, language neutrality, and analytical (not prescriptive) tone.
- 9-10: Every uncertain claim hedged with ranges and caveats; fully accessible to outsiders; presents tradeoffs without advocating (journal-quality neutrality)
- 7-8: Nearly all estimates include ranges; no insider jargon; analytical throughout; honest counter-arguments included (exceptional)
- 5-6: Mostly neutral language; some uncertainty acknowledgment; mostly analytical but occasional prescriptive slips
- 3-4: Uses insider jargon (e.g., "EA money", "non-EA charities"); presents rough estimates as facts (e.g., "True Cost: $500K"); one-sided framing without counter-arguments
- 1-2: Heavy insider language throughout; false certainty; reads as advocacy not analysis
- 0: Pure advocacy with no epistemic honesty

OBJECTIVITY CALIBRATION (critical):
- Page that says "EA organizations should pressure founders" → 2-3 (prescriptive, insider framing)
- Page that says "True Cost: $500K, Realistic EV: $50M" → 3-4 (false certainty)
- Page that uses ranges but still says "EA causes" → 4-5 (mixed)
- Page that says "Est. cost: $300K-1M" and names specific orgs → 6-7
- Page that includes "Why These Numbers Might Be Wrong" and red-teams its own conclusions → 7-8

CALIBRATION: For typical wiki content, expect scores of 3-5. A score of 6+ means genuinely strong. A 7+ is rare and exceptional. 8+ should almost never be given. ESPECIALLY for novelty - most pages are compilations (3-4), not original insights (6+).

**Scoring guidelines:**

90-100: Essential for prioritization decisions. Core intervention strategies, key risk mechanisms, or foundational capabilities that directly inform resource allocation. (Expect ~5-10 pages)

70-89: High value for practitioners. Concrete responses, major risk categories, critical capabilities. Directly actionable or necessary context for action. (Expect ~30-50 pages)

50-69: Useful context. Supporting analysis, secondary risks, background on actors/institutions. Helps round out understanding. (Expect ~80-100 pages)

30-49: Reference material. Historical context, individual profiles, niche topics. Useful for specialists, not core prioritization. (Expect ~60-80 pages)

0-29: Peripheral. Internal docs, tangential topics, stubs. (Expect ~30-50 pages)

**Category adjustments (apply to your base assessment):**
- Responses/interventions (technical safety, governance, policy): +10 (actionable)
- Capabilities (what AI can do): +5 (foundational for risk assessment)
- Core risks (accident, misuse): +5 (direct relevance)
- Risk factors: 0 (contributing factors)
- Models/analysis: -5 (meta-level, not direct prioritization)
- Arguments/debates: -10 (discourse, not action)
- People/organizations: -15 (reference material)
- Internal/infrastructure: -30

Also provide:
- **llmSummary**: 1-2 sentences with methodology AND conclusions (include numbers if available)

Respond with valid JSON only, no markdown.`;

const USER_PROMPT_TEMPLATE: string = `Grade this content page:

**File path**: {{filePath}}
**Category**: {{category}}
**Content type**: {{contentType}}
**Title**: {{title}}
**Description**: {{description}}

---
FULL CONTENT:
{{content}}
---

Respond with JSON (keep reasoning SHORT - max 2-3 sentences total):
{
  "importance": <0-100, one decimal>,
  "ratings": {
    "focus": <0-10, one decimal>,
    "novelty": <0-10, one decimal>,
    "rigor": <0-10, one decimal>,
    "completeness": <0-10, one decimal>,
    "concreteness": <0-10, one decimal>,
    "actionability": <0-10, one decimal>,
    "objectivity": <0-10, one decimal>
  },
  "llmSummary": "<1-2 sentences with conclusions>",
  "reasoning": "<2-3 sentences max explaining the scores>"
}`;

interface Frontmatter {
  title?: string;
  description?: string;
  importance?: number | null;
  quality?: number | null;
  ratings?: Ratings | null;
  metrics?: Metrics;
  pageType?: string;
  contentType?: string;
  lastEdited?: string | Date;
  [key: string]: unknown;
}

interface Ratings {
  focus: number;
  novelty: number;
  rigor: number;
  completeness: number;
  concreteness: number;
  actionability: number;
  objectivity: number;
}

interface Metrics {
  wordCount: number;
  citations: number;
  tables: number;
  diagrams: number;
}

interface PageInfo {
  id: string;
  filePath: string;
  relativePath: string;
  urlPath: string;
  title: string;
  category: string;
  subcategory: string | null;
  isModel: boolean;
  pageType: string;
  contentFormat: string;
  currentImportance: number | null;
  currentQuality: number | null;
  currentRatings: Ratings | null;
  content: string;
  frontmatter: Frontmatter;
}

interface Warning {
  rule: string;
  line?: number;
  message: string;
  severity: string;
}

interface ChecklistWarning {
  id: string;
  quote: string;
  note: string;
}

interface GradeResult {
  importance: number;
  ratings: Ratings;
  llmSummary?: string;
  reasoning?: string;
}

interface PageResult {
  id: string;
  filePath: string;
  category: string;
  isModel?: boolean;
  title: string;
  importance?: number;
  ratings?: Ratings;
  metrics: Metrics;
  quality?: number;
  llmSummary?: string;
  warnings?: {
    automated: Warning[];
    checklist: ChecklistWarning[];
    totalCount: number;
  };
}

interface ProcessPageResult {
  success: boolean;
  result?: PageResult;
  error?: string;
}

/**
 * Detect page type based on filename and frontmatter
 * - 'overview': index.mdx files (navigation pages)
 * - 'stub': explicitly marked in frontmatter (intentionally minimal)
 * - 'content': default (full quality criteria apply)
 */
function detectPageType(id: string, frontmatter: Frontmatter): string {
  // Auto-detect overview pages from filename
  if (id === 'index') return 'overview';

  // Explicit stub marking in frontmatter
  if (frontmatter.pageType === 'stub') return 'stub';

  // Default to content
  return 'content';
}

/**
 * Scan content directory and collect all pages.
 * Uses shared findMdxFiles for file discovery.
 */
function collectPages(): PageInfo[] {
  const files = findMdxFiles(CONTENT_DIR);
  const pages: PageInfo[] = [];

  for (const fullPath of files) {
    const content = readFileSync(fullPath, 'utf-8');
    const fm = extractFrontmatter(content) as Frontmatter;
    const entry = basename(fullPath);
    const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');

    // Determine category from relative path
    const relPath = relative(CONTENT_DIR, fullPath);
    const pathParts = dirname(relPath).split('/').filter(p => p && p !== '.');
    const category = pathParts[0] || 'other';
    const subcategory = pathParts[1] || null;
    const urlPrefix = '/' + pathParts.join('/');

    // Check if it's a model page
    const isModel = relPath.includes('/models') || fm.ratings !== undefined;

    // Detect page type
    const pageType = detectPageType(id, fm);

    pages.push({
      id,
      filePath: fullPath,
      relativePath: relPath,
      urlPath: id === 'index' ? `${urlPrefix}/` : `${urlPrefix}/${id}/`,
      title: fm.title || id.replace(/-/g, ' '),
      category,
      subcategory,
      isModel,
      pageType,
      contentFormat: fm.contentFormat || 'article',
      currentImportance: fm.importance ?? null,
      currentQuality: fm.quality ?? null,
      currentRatings: fm.ratings ?? null,
      content,
      frontmatter: fm,
    });
  }

  return pages;
}

/**
 * Extract frontmatter from content.
 * Delegates to shared parseFrontmatter from mdx-utils.
 */
const extractFrontmatter = parseFrontmatter;

/**
 * Get content without frontmatter, optionally truncated
 */
function getContent(text: string, maxWords: number = 10000): string {
  // Remove frontmatter
  const withoutFm = text.replace(/^---[\s\S]*?---\n*/, '');
  const words = withoutFm.split(/\s+/);
  if (words.length <= maxWords) return withoutFm;
  return words.slice(0, maxWords).join(' ') + '\n\n[... truncated at ' + maxWords + ' words]';
}

/**
 * Compute automated metrics from content
 */
function computeMetrics(content: string): Metrics {
  const withoutFm = content.replace(/^---[\s\S]*?---\n*/, '');

  // Remove table content for prose word count
  const withoutTables = withoutFm.replace(/\|[^\n]+\|/g, '');
  const withoutCodeBlocks = withoutTables.replace(/```[\s\S]*?```/g, '');
  const withoutImports = withoutCodeBlocks.replace(/^import\s+.*$/gm, '');
  const withoutComponents = withoutImports.replace(/<[^>]+\/>/g, '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '');
  const proseWords = withoutComponents.split(/\s+/).filter(w => w.length > 0).length;

  // Count citations: <R id="..."> and markdown links [text](url)
  const rComponents = (withoutFm.match(/<R\s+id=/g) || []).length;
  const mdLinks = (withoutFm.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g) || []).length;
  const citations = rComponents + mdLinks;

  // Count tables (markdown tables with |---|)
  const tables = (withoutFm.match(/\|[-:]+\|/g) || []).length;

  // Count diagrams (Mermaid components and images)
  const mermaid = (withoutFm.match(/<Mermaid/g) || []).length;
  const images = (withoutFm.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
  const diagrams = mermaid + images;

  return { wordCount: proseWords, citations, tables, diagrams };
}

/**
 * Detect content type from frontmatter or path
 */
function detectContentType(frontmatter: Frontmatter, relativePath: string): string {
  // Explicit setting takes precedence
  if (frontmatter.contentType) return frontmatter.contentType;

  // Infer from path
  if (relativePath.includes('/models/')) return 'analysis';
  if (relativePath.includes('/organizations/') || relativePath.includes('/people/')) return 'reference';

  // Default
  return 'reference';
}

interface Weights {
  focus: number;
  novelty: number;
  rigor: number;
  completeness: number;
  concreteness: number;
  actionability: number;
  objectivity: number;
}

/**
 * Compute derived quality score from ratings, metrics, and frontmatter
 *
 * Content-type-specific weighting:
 * - analysis: focus, novelty, concreteness weighted 1.5x (original insight matters)
 * - reference: rigor, completeness weighted 1.5x (accuracy matters)
 * - explainer: completeness, rigor weighted 1.5x (educational coverage matters)
 *
 * Formula: weightedAvg x 8 + min(8, words/600) + min(7, citations x 0.35)
 * - Subscores drive 0-80 (primary factor)
 * - Length bonus: 0-8 (4800 words = max) - reduced from previous
 * - Evidence bonus: 0-7 (20 citations = max) - reduced from previous
 * - Caps: stub pages at 35, very short pages at 40
 * - Total range: 0-95 effectively (100 requires exceptional subscores + length + citations)
 */
function computeQuality(ratings: Ratings, metrics: Metrics, frontmatter: Frontmatter = {}, relativePath: string = ''): number {
  const contentType = detectContentType(frontmatter, relativePath);

  // Get ratings with defaults (handle missing ratings gracefully)
  const focus = ratings.focus ?? 5;
  const novelty = ratings.novelty ?? 5;
  const rigor = ratings.rigor ?? 5;
  const completeness = ratings.completeness ?? 5;
  const concreteness = ratings.concreteness ?? 5;
  const actionability = ratings.actionability ?? 5;
  const objectivity = ratings.objectivity ?? 5;

  // Content-type-specific weighting
  let weights: Weights;
  if (contentType === 'analysis') {
    // Analysis pages: focus, novelty, concreteness matter most; objectivity critical for credibility
    weights = {
      focus: 1.5,
      novelty: 1.5,
      rigor: 1.0,
      completeness: 0.8,
      concreteness: 1.5,
      actionability: 1.2,
      objectivity: 1.2
    };
  } else if (contentType === 'explainer') {
    // Explainer pages: completeness, rigor matter most; objectivity moderate
    weights = {
      focus: 1.0,
      novelty: 0.5,
      rigor: 1.5,
      completeness: 1.5,
      concreteness: 1.0,
      actionability: 0.5,
      objectivity: 0.8
    };
  } else {
    // Reference pages: rigor, completeness matter most; objectivity important for neutrality
    weights = {
      focus: 1.0,
      novelty: 0.8,
      rigor: 1.5,
      completeness: 1.5,
      concreteness: 1.0,
      actionability: 0.5,
      objectivity: 1.0
    };
  }

  // Compute weighted average
  const totalWeight: number = Object.values(weights).reduce((a, b) => a + b, 0);
  const weightedSum: number =
    focus * weights.focus +
    novelty * weights.novelty +
    rigor * weights.rigor +
    completeness * weights.completeness +
    concreteness * weights.concreteness +
    actionability * weights.actionability +
    objectivity * weights.objectivity;

  const weightedAvg: number = weightedSum / totalWeight;

  // Subscores contribute 0-80 points (primary driver)
  const baseScore: number = weightedAvg * 8;  // Maps 0-10 → 0-80

  // Length contributes 0-8 points (reduced from 10)
  const lengthScore: number = Math.min(8, metrics.wordCount / 600);

  // Evidence contributes 0-7 points (reduced from 10)
  const evidenceScore: number = Math.min(7, metrics.citations * 0.35);

  // Compute base quality
  let quality: number = baseScore + lengthScore + evidenceScore;

  // Stub pages should never exceed 35 (explicitly marked as minimal)
  if (frontmatter.pageType === 'stub') {
    quality = Math.min(quality, 35);
  }

  // Very short pages (<100 words) capped at 40
  if (metrics.wordCount < 100) {
    quality = Math.min(quality, 40);
  }

  return Math.round(Math.max(0, quality));
}

// Warning rules used in Step 1
const WARNING_RULES = [
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
];

/**
 * Step 1: Run automated validation rules against a single page
 * Returns an array of warning objects { rule, line, message, severity }
 */
async function runAutomatedWarnings(page: PageInfo): Promise<Warning[]> {
  const engine = new ValidationEngine();
  await engine.load();

  // Find the content file in the engine's loaded content
  const contentFile = engine.content.get(page.filePath);
  if (!contentFile) {
    // Create a ContentFile from the page data
    const cf = new ContentFile(page.filePath, page.content);
    const issues: Warning[] = [];
    for (const rule of WARNING_RULES) {
      const ruleIssues = await rule.check(cf, engine);
      if (Array.isArray(ruleIssues)) {
        issues.push(...ruleIssues);
      }
    }
    return issues.map(i => ({
      rule: i.rule,
      line: i.line,
      message: i.message,
      severity: i.severity,
    }));
  }

  const issues: Warning[] = [];
  for (const rule of WARNING_RULES) {
    const ruleIssues = await rule.check(contentFile, engine);
    if (Array.isArray(ruleIssues)) {
      issues.push(...ruleIssues);
    }
  }
  return issues.map(i => ({
    rule: i.rule,
    line: i.line,
    message: i.message,
    severity: i.severity,
  }));
}

// Step 2: LLM checklist system prompt
const CHECKLIST_SYSTEM_PROMPT: string = `You are a content quality reviewer. Review the page against the checklist items below. For each item that applies (i.e., the page has this problem), return it in your response. Skip items where the page is fine.

Be precise and specific — cite line numbers or quotes when flagging an issue.

Respond with valid JSON only, no markdown.`;

const CHECKLIST_USER_TEMPLATE: string = `Review this page against the content quality checklist.

**Title**: {{title}}
**Content type**: {{contentType}}

---
CONTENT:
{{content}}
---

For each checklist item where this page has a problem, include it in the warnings array. Only include items where there IS a problem. Be specific — quote the problematic text.

Checklist categories:
- Objectivity & Tone (OBJ): insider jargon, false certainty, loaded language, prescriptive voice, asymmetric skepticism, editorializing
- Rigor & Evidence (RIG): unsourced claims, missing ranges, stale data, false precision, cherry-picked evidence, inconsistent numbers
- Focus & Structure (FOC): title mismatch, scope creep, buried lede, redundant sections, wall of text
- Completeness (CMP): missing counterarguments, missing stakeholders, unanswered questions, missing limitations
- Concreteness (CON): vague generalities, abstract recommendations, vague timelines, missing magnitudes
- Cross-Page (XPC): contradictory figures, stale valuations, missing cross-references
- Formatting (FMT): long paragraphs, missing data dates, formatting inconsistencies

Respond with JSON:
{
  "warnings": [
    {"id": "<checklist ID like OBJ-01>", "quote": "<problematic text>", "note": "<brief explanation>"},
    ...
  ]
}`;

/**
 * Step 2: Run LLM checklist review using Haiku
 * Returns an array of warning objects from checklist review
 */
async function runChecklistReview(client: Anthropic, page: PageInfo): Promise<ChecklistWarning[]> {
  const fullContent = getContent(page.content, 6000); // Shorter for Haiku
  const contentType = detectContentType(page.frontmatter, page.relativePath);

  const userPrompt: string = CHECKLIST_USER_TEMPLATE
    .replace('{{title}}', page.title)
    .replace('{{contentType}}', contentType)
    .replace('{{content}}', fullContent);

  try {
    const result = await callClaude(client, {
      model: 'haiku',
      systemPrompt: CHECKLIST_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 1500,
    });

    const parsed = parseJsonResponse(result.text) as { warnings?: ChecklistWarning[] };
    return parsed.warnings || [];
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`  Checklist review failed for ${page.id}: ${error.message}`);
    return [];
  }
}

/**
 * Format warnings summary for inclusion in the rating prompt
 */
function formatWarningsSummary(automatedWarnings: Warning[], checklistWarnings: ChecklistWarning[]): string {
  const lines: string[] = [];

  if (automatedWarnings.length > 0) {
    lines.push('**Automated rule warnings:**');
    for (const w of automatedWarnings.slice(0, 15)) { // Cap at 15 to avoid prompt bloat
      lines.push(`- [${w.rule}] Line ${w.line}: ${w.message}`);
    }
    if (automatedWarnings.length > 15) {
      lines.push(`- ... and ${automatedWarnings.length - 15} more`);
    }
  }

  if (checklistWarnings.length > 0) {
    lines.push('**Checklist review warnings:**');
    for (const w of checklistWarnings.slice(0, 15)) {
      lines.push(`- [${w.id}] "${w.quote}" — ${w.note}`);
    }
    if (checklistWarnings.length > 15) {
      lines.push(`- ... and ${checklistWarnings.length - 15} more`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No warnings from automated checks or checklist review.';
}

/**
 * Step 3: Call Claude API to grade a page (original behavior, now with warnings context)
 */
async function gradePage(client: Anthropic, page: PageInfo, warningsSummary: string | null = null): Promise<GradeResult | null> {
  const fullContent = getContent(page.content);
  const contentType = detectContentType(page.frontmatter, page.relativePath);

  let userPrompt: string = USER_PROMPT_TEMPLATE
    .replace('{{filePath}}', page.relativePath)
    .replace('{{category}}', page.category)
    .replace('{{contentType}}', contentType)
    .replace('{{title}}', page.title)
    .replace('{{description}}', page.frontmatter.description || '(none)')
    .replace('{{content}}', fullContent);

  // Append warnings context from Steps 1-2 if available
  if (warningsSummary) {
    userPrompt += `\n\n---\nPRE-SCREENING WARNINGS (from automated rules and checklist review — factor these into your ratings, especially objectivity, rigor, and concreteness):\n${warningsSummary}\n---`;
  }

  const response = await callClaude(client, {
    model: 'sonnet',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800,
  });

  try {
    return parseJsonResponse(response.text) as GradeResult;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`Failed to parse response for ${page.id}:`, response.text);
    return null;
  }
}

/**
 * Apply grades to frontmatter
 */
function applyGradesToFile(page: PageInfo, grades: GradeResult, metrics: Metrics, derivedQuality: number): boolean {
  const content = readFileSync(page.filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (!fmMatch) {
    console.warn(`No frontmatter found in ${page.filePath}`);
    return false;
  }

  const fm = parseYaml(fmMatch[1]) || {} as Record<string, unknown>;

  // Update fields
  fm.importance = grades.importance;
  fm.quality = derivedQuality;
  if (grades.llmSummary) {
    fm.llmSummary = grades.llmSummary;
  }
  // Always apply ratings now (not just for model pages)
  if (grades.ratings) {
    fm.ratings = grades.ratings;
  }
  // Save metrics
  fm.metrics = metrics;

  // Ensure lastEdited is a string (not Date object)
  if (fm.lastEdited instanceof Date) {
    fm.lastEdited = fm.lastEdited.toISOString().split('T')[0];
  }

  // Reconstruct file with proper quoting for date strings
  let newFm: string = stringifyYaml(fm, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0  // Don't wrap lines
  });

  // Fix: Ensure lastEdited is always quoted (YAML stringifier doesn't quote date-like strings)
  newFm = newFm.replace(/^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})$/m, '$1"$2"');

  // Ensure frontmatter ends with newline
  if (!newFm.endsWith('\n')) {
    newFm += '\n';
  }

  const bodyStart: number = content.indexOf('---', 4) + 3; // Skip past '---' only, not the newline
  let body: string = content.slice(bodyStart);
  // Ensure body starts with exactly one newline
  body = '\n' + body.replace(/^\n+/, '');
  const newContent: string = `---\n${newFm}---${body}`;

  // Validation: ensure file structure is correct
  const fmTest = newContent.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmTest) {
    console.error(`ERROR: Invalid frontmatter structure in ${page.filePath}`);
    console.error('Frontmatter must end with ---\\n');
    return false;
  }

  // Validation: ensure no corrupted imports (e.g., "mport" instead of "import")
  const afterFm: string = newContent.slice(fmTest[0].length);
  if (/^[a-z]/.test(afterFm.trim()) && !/^(import|export|const|let|var|function|class|\/\/)/.test(afterFm.trim())) {
    console.error(`ERROR: Suspicious content after frontmatter in ${page.filePath}`);
    console.error(`First chars: "${afterFm.slice(0, 50)}..."`);
    return false;
  }

  writeFileSync(page.filePath, newContent);
  return true;
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  console.log('Content Grading Script — 3-Step Pipeline');
  console.log('==========================================\n');

  if (options.skipWarnings) {
    console.log('Mode: Skip warnings (Step 3 only — backward compat)');
  } else if (options.warningsOnly) {
    console.log('Mode: Warnings only (Steps 1-2, no rating)');
  } else {
    console.log('Mode: Full 3-step pipeline (warnings → checklist → rating)');
  }

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY && !options.dryRun) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... node crux/authoring/grade-content.ts');
    process.exit(1);
  }

  // Collect pages
  let pages: PageInfo[] = collectPages();
  console.log(`Found ${pages.length} total pages\n`);

  // Apply filters
  if (options.page) {
    const query = options.page.toLowerCase();
    pages = pages.filter(p =>
      p.id.toLowerCase().includes(query) ||
      p.title.toLowerCase().includes(query) ||
      p.relativePath.toLowerCase().includes(query)
    );
    if (pages.length === 0) {
      console.error(`No pages found matching: ${options.page}`);
      process.exit(1);
    }
    if (pages.length > 1) {
      console.log(`Found ${pages.length} matching pages:`);
      pages.forEach(p => console.log(`  - ${p.id}: ${p.title}`));
      console.log(`\nUse a more specific query or the full ID.`);
      process.exit(1);
    }
    console.log(`Grading single page: ${pages[0].title}`);
  }

  if (options.category) {
    pages = pages.filter(p => p.category === options.category || p.subcategory === options.category);
    console.log(`Filtered to ${pages.length} pages in category: ${options.category}`);
  }

  if (options.skipGraded) {
    pages = pages.filter(p => p.currentImportance === null);
    console.log(`Filtered to ${pages.length} pages without importance`);
  }

  // Skip overview pages (index.mdx), stub pages, non-graded formats, and internal files (starting with _)
  const skippedOverview: number = pages.filter(p => p.pageType === 'overview').length;
  const skippedStub: number = pages.filter(p => p.pageType === 'stub').length;
  const nonGradedFormats = ['index', 'dashboard'];
  const skippedFormat: number = pages.filter(p => nonGradedFormats.includes(p.contentFormat)).length;
  pages = pages.filter(p => p.pageType === 'content' && !p.id.startsWith('_') && !nonGradedFormats.includes(p.contentFormat));
  console.log(`Filtered to ${pages.length} content pages (skipped ${skippedOverview} overview, ${skippedStub} stub, ${skippedFormat} non-graded format)`);

  if (options.limit) {
    pages = pages.slice(0, options.limit);
    console.log(`Limited to ${pages.length} pages`);
  }

  // Cost estimate (with full content)
  const avgTokens = 4000; // input per page (~2500 words avg + metadata)
  const outputTokens = 200; // output per page
  const sonnetInputCost: number = (pages.length * avgTokens / 1_000_000) * 3;
  const sonnetOutputCost: number = (pages.length * outputTokens / 1_000_000) * 15;
  const haikuInputCost: number = (pages.length * 3000 / 1_000_000) * 0.80; // Haiku pricing
  const haikuOutputCost: number = (pages.length * 500 / 1_000_000) * 4;

  let totalCost: number;
  if (options.warningsOnly) {
    totalCost = haikuInputCost + haikuOutputCost;
    console.log(`\nCost Estimate (warnings-only — Step 2 Haiku):`);
    console.log(`  Haiku: $${totalCost.toFixed(2)}\n`);
  } else if (options.skipWarnings) {
    totalCost = sonnetInputCost + sonnetOutputCost;
    console.log(`\nCost Estimate (skip-warnings — Step 3 Sonnet only):`);
    console.log(`  Sonnet: $${totalCost.toFixed(2)}\n`);
  } else {
    totalCost = sonnetInputCost + sonnetOutputCost + haikuInputCost + haikuOutputCost;
    console.log(`\nCost Estimate (full pipeline — Haiku + Sonnet):`);
    console.log(`  Step 2 (Haiku):  $${(haikuInputCost + haikuOutputCost).toFixed(2)}`);
    console.log(`  Step 3 (Sonnet): $${(sonnetInputCost + sonnetOutputCost).toFixed(2)}`);
    console.log(`  Total:           $${totalCost.toFixed(2)}\n`);
  }

  if (options.dryRun) {
    console.log('Dry run - pages that would be processed:');
    for (const page of pages.slice(0, 20)) {
      console.log(`  - ${page.relativePath} (${page.category}${page.isModel ? ', model' : ''})`);
    }
    if (pages.length > 20) {
      console.log(`  ... and ${pages.length - 20} more`);
    }
    return;
  }

  // Initialize API client (handles API key validation)
  const client = createClient()!;

  // Process pages
  const results: PageResult[] = [];
  let processed = 0;
  let errors = 0;

  const concurrency: number = options.parallel;
  console.log(`Processing ${pages.length} pages with concurrency ${concurrency}...\n`);

  // Process in batches for parallel execution
  async function processPage(page: PageInfo, index: number): Promise<ProcessPageResult> {
    try {
      let automatedWarnings: Warning[] = [];
      let checklistWarnings: ChecklistWarning[] = [];
      let warningsSummary: string | null = null;

      // Step 1 & 2: Run warnings (unless --skip-warnings)
      if (!options.skipWarnings) {
        // Step 1: Automated warnings (always fast, no API)
        automatedWarnings = await runAutomatedWarnings(page);
        console.log(`  [${index + 1}/${pages.length}] ${page.id}: Step 1 — ${automatedWarnings.length} automated warnings`);

        // Step 2: LLM checklist review (Haiku)
        if (!options.dryRun) {
          checklistWarnings = await runChecklistReview(client, page);
          console.log(`  [${index + 1}/${pages.length}] ${page.id}: Step 2 — ${checklistWarnings.length} checklist warnings`);
        }

        warningsSummary = formatWarningsSummary(automatedWarnings, checklistWarnings);
      }

      // If --warnings-only, skip Step 3
      if (options.warningsOnly) {
        const metrics = computeMetrics(page.content);
        const result: PageResult = {
          id: page.id,
          filePath: page.relativePath,
          category: page.category,
          title: page.title,
          metrics,
          warnings: {
            automated: automatedWarnings,
            checklist: checklistWarnings,
            totalCount: automatedWarnings.length + checklistWarnings.length,
          },
        };
        console.log(`[${index + 1}/${pages.length}] ${page.id}: ${automatedWarnings.length + checklistWarnings.length} total warnings (warnings-only mode)`);
        return { success: true, result };
      }

      // Step 3: LLM rating (Sonnet)
      const grades = await gradePage(client, page, warningsSummary);

      if (grades && grades.ratings) {
        // Compute automated metrics
        const metrics = computeMetrics(page.content);

        // Compute derived quality score
        const derivedQuality = computeQuality(grades.ratings, metrics, page.frontmatter, page.relativePath);

        const result: PageResult = {
          id: page.id,
          filePath: page.relativePath,
          category: page.category,
          isModel: page.isModel,
          title: page.title,
          importance: grades.importance,
          ratings: grades.ratings,
          metrics,
          quality: derivedQuality,
          llmSummary: grades.llmSummary,
          warnings: options.skipWarnings ? undefined : {
            automated: automatedWarnings,
            checklist: checklistWarnings,
            totalCount: automatedWarnings.length + checklistWarnings.length,
          },
        };

        let applied = false;
        if (options.apply) {
          applied = applyGradesToFile(page, grades, metrics, derivedQuality);
          if (!applied) {
            console.error(`  Failed to apply grades to ${page.filePath}`);
          }
        }

        const r = grades.ratings;
        const warnCount: string = options.skipWarnings ? '' : ` [${automatedWarnings.length + checklistWarnings.length}w]`;
        console.log(`[${index + 1}/${pages.length}] ${page.id}: imp=${grades.importance.toFixed(1)}, f=${r.focus} n=${r.novelty} r=${r.rigor} c=${r.completeness} con=${r.concreteness} a=${r.actionability} o=${r.objectivity} → qual=${derivedQuality} (${metrics.wordCount}w, ${metrics.citations}cit)${warnCount}${options.apply ? (applied ? ' ok' : ' FAIL') : ''}`);
        return { success: true, result };
      } else {
        console.log(`[${index + 1}/${pages.length}] ${page.id}: FAILED (no ratings in response)`);
        return { success: false };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`[${index + 1}/${pages.length}] ${page.id}: ERROR - ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Process in parallel batches
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    const batchPromises = batch.map((page, batchIndex) =>
      processPage(page, i + batchIndex)
    );

    const batchResults = await Promise.all(batchPromises);

    for (const br of batchResults) {
      if (br.success) {
        results.push(br.result!);
        processed++;
      } else {
        errors++;
      }
    }

    // Rate limiting - be nice to the API
    await new Promise<void>(r => setTimeout(r, 200));
  }

  // Write results (ensure output directory exists)
  const outputDir = dirname(options.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(options.output, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${options.output}`);
  console.log(`Processed: ${processed}, Errors: ${errors}`);

  // Summary statistics
  const importanceScores: number[] = results.map(r => r.importance).filter((x): x is number => x != null).sort((a, b) => b - a);
  const qualityScores: number[] = results.map(r => r.quality).filter((x): x is number => x != null).sort((a, b) => b - a);

  // Importance distribution by range
  const impRanges: Record<string, number> = {
    '90-100': importanceScores.filter(x => x >= 90).length,
    '70-89': importanceScores.filter(x => x >= 70 && x < 90).length,
    '50-69': importanceScores.filter(x => x >= 50 && x < 70).length,
    '30-49': importanceScores.filter(x => x >= 30 && x < 50).length,
    '0-29': importanceScores.filter(x => x < 30).length,
  };

  console.log('\nImportance Distribution (0-100):');
  for (const [range, count] of Object.entries(impRanges)) {
    const bar = '\u2588'.repeat(Math.ceil(count / 3));
    console.log(`  ${range}: ${bar} (${count})`);
  }

  if (importanceScores.length > 0) {
    const impAvg: number = importanceScores.reduce((a, b) => a + b, 0) / importanceScores.length;
    const impMedian: number = importanceScores[Math.floor(importanceScores.length / 2)];
    console.log(`\n  Avg: ${impAvg.toFixed(1)}, Median: ${impMedian.toFixed(1)}`);
    console.log(`  Top 5: ${importanceScores.slice(0, 5).map(x => x.toFixed(1)).join(', ')}`);
    console.log(`  Bottom 5: ${importanceScores.slice(-5).map(x => x.toFixed(1)).join(', ')}`);
  }

  // Quality distribution by range (0-100 scale)
  const qualRanges: Record<string, number> = {
    '80-100 (Comprehensive)': qualityScores.filter(x => x >= 80).length,
    '60-79 (Good)': qualityScores.filter(x => x >= 60 && x < 80).length,
    '40-59 (Adequate)': qualityScores.filter(x => x >= 40 && x < 60).length,
    '20-39 (Draft)': qualityScores.filter(x => x >= 20 && x < 40).length,
    '0-19 (Stub)': qualityScores.filter(x => x < 20).length,
  };

  console.log('\nQuality Distribution (0-100):');
  for (const [range, count] of Object.entries(qualRanges)) {
    const bar = '\u2588'.repeat(Math.ceil(count / 3));
    console.log(`  ${range}: ${bar} (${count})`);
  }

  if (qualityScores.length > 0) {
    const qualAvg: number = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
    const qualMedian: number = qualityScores[Math.floor(qualityScores.length / 2)];
    console.log(`\n  Avg: ${qualAvg.toFixed(1)}, Median: ${qualMedian.toFixed(1)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
