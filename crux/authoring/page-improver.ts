#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Page Improvement Pipeline
 *
 * Multi-phase improvement pipeline with SCRY research and specific directions.
 * Similar to page-creator but for improving existing pages.
 *
 * Usage:
 *   # Basic improvement with directions
 *   node crux/authoring/page-improver.ts -- open-philanthropy --directions "add 2024 funding data"
 *
 *   # Research-heavy improvement
 *   node crux/authoring/page-improver.ts -- far-ai --tier deep --directions "add recent publications"
 *
 *   # Quick polish only
 *   node crux/authoring/page-improver.ts -- cea --tier polish
 *
 * Tiers:
 *   - polish ($2): Single-pass improvement, no research
 *   - standard ($5): Light research + improvement + review
 *   - deep ($10): Full SCRY + web research, multi-phase improvement
 */

import dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolUseBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { MODELS } from '../lib/anthropic.ts';
// Inlined from content-types.ts to keep this file self-contained
const CRITICAL_RULES: string[] = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls',
];

const QUALITY_RULES: string[] = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts',
  'evaluative-framing',
  'tone-markers',
  'false-certainty',
  'prescriptive-language',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT: string = path.join(__dirname, '../..');

// Node command with tsx loader — required for running .ts scripts as subprocesses
const NODE_TSX: string = 'node --import tsx/esm --no-warnings';
const TEMP_DIR: string = path.join(ROOT, '.claude/temp/page-improver');

// SCRY API config
const SCRY_PUBLIC_KEY: string = process.env.SCRY_API_KEY || 'exopriors_public_readonly_v1_2025';

interface TierConfig {
  name: string;
  cost: string;
  phases: string[];
  description: string;
}

// Tier configurations
const TIERS: Record<string, TierConfig> = {
  polish: {
    name: 'Polish',
    cost: '$2-3',
    phases: ['analyze', 'improve', 'validate'],
    description: 'Quick single-pass improvement without research'
  },
  standard: {
    name: 'Standard',
    cost: '$5-8',
    phases: ['analyze', 'research', 'improve', 'validate', 'review'],
    description: 'Light research + improvement + validation + review'
  },
  deep: {
    name: 'Deep Research',
    cost: '$10-15',
    phases: ['analyze', 'research-deep', 'improve', 'validate', 'review', 'gap-fill'],
    description: 'Full SCRY + web research, validation, multi-phase improvement'
  }
};

// Initialize Anthropic client
const anthropic = new Anthropic();

interface PageData {
  id: string;
  title: string;
  path: string;
  quality?: number;
  importance?: number;
  ratings?: {
    objectivity?: number;
    rigor?: number;
    focus?: number;
    novelty?: number;
    completeness?: number;
    concreteness?: number;
    actionability?: number;
    [key: string]: number | undefined;
  };
}

interface AnalysisResult {
  currentState?: string;
  gaps?: string[];
  researchNeeded?: string[];
  improvements?: string[];
  entityLinks?: string[];
  citations?: unknown;
  raw?: string;
  error?: string;
}

interface ResearchResult {
  sources: Array<{
    topic: string;
    title: string;
    url: string;
    author?: string;
    date?: string;
    facts: string[];
    relevance: string;
  }>;
  summary?: string;
  raw?: string;
  error?: string;
}

interface ReviewResult {
  valid: boolean;
  issues: string[];
  suggestions?: string[];
  qualityScore?: number;
  raw?: string;
}

interface ValidationIssue {
  rule: string;
  count?: number;
  output?: string;
  error?: string;
}

interface ValidationResult {
  issues: {
    critical: ValidationIssue[];
    quality: ValidationIssue[];
  };
  hasCritical: boolean;
  improvedContent: string;
}

interface RunAgentOptions {
  model?: string;
  maxTokens?: number;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  systemPrompt?: string;
}

interface PipelineOptions {
  tier?: string;
  directions?: string;
  dryRun?: boolean;
  grade?: boolean;
  analysisModel?: string;
  researchModel?: string;
  improveModel?: string;
  reviewModel?: string;
  deep?: boolean;
}

interface PipelineResults {
  pageId: string;
  title: string;
  tier: string;
  directions: string;
  duration: string;
  phases: string[];
  review: ReviewResult | undefined;
  outputPath: string;
}

interface ListOptions {
  limit?: number;
  maxQuality?: number;
  minImportance?: number;
}

interface ParsedArgs {
  _positional: string[];
  [key: string]: string | boolean | string[];
}

// Formatting helpers
function formatTime(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 8);
}

function log(phase: string, message: string): void {
  console.log(`[${formatTime()}] [${phase}] ${message}`);
}

// File operations
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeTemp(pageId: string, filename: string, content: string | object): string {
  const dir = path.join(TEMP_DIR, pageId);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return filePath;
}

// Build objectivity context from previous ratings and analysis
function buildObjectivityContext(page: PageData, analysis: AnalysisResult): string {
  const parts: string[] = [];
  const objScore = page.ratings?.objectivity;

  if (objScore !== undefined && objScore < 6) {
    parts.push(`## ⚠️ Objectivity Alert`);
    parts.push(`This page's previous objectivity rating was **${objScore}/10** (below the 6.0 threshold).`);
    parts.push(`Pay special attention to neutrality — this page has a history of biased framing.`);
    parts.push('');
  }

  const objectivityIssues = (analysis as any).objectivityIssues as string[] | undefined;
  if (objectivityIssues && objectivityIssues.length > 0) {
    if (parts.length === 0) parts.push('## Objectivity Issues Found in Analysis');
    else parts.push('### Specific Issues Identified');
    for (const issue of objectivityIssues) {
      parts.push(`- ${issue}`);
    }
    parts.push('');
    parts.push('**Fix all of these objectivity issues** in your improvement. Replace evaluative language with neutral descriptions backed by data.');
    parts.push('');
  }

  return parts.length > 0 ? '\n' + parts.join('\n') + '\n' : '';
}

// Load page data
function loadPages(): PageData[] {
  const pagesPath = path.join(ROOT, 'app/src/data/pages.json');
  if (!fs.existsSync(pagesPath)) {
    console.error('Error: pages.json not found. Run `pnpm build` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pagesPath, 'utf-8'));
}

// Enrich page data with ratings from frontmatter (pages.json doesn't include objectivity)
function enrichWithFrontmatterRatings(page: PageData): PageData {
  try {
    const filePath = getFilePath(page.path);
    if (!fs.existsSync(filePath)) return page;
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return page;
    const fm = fmMatch[1];
    // Parse ratings block from YAML frontmatter
    const ratingsMatch = fm.match(/^ratings:\s*\n((?:\s+\w+:\s*[\d.]+\n?)*)/m);
    if (ratingsMatch) {
      const ratings: Record<string, number> = {};
      const lines = ratingsMatch[1].split('\n');
      for (const line of lines) {
        const kv = line.match(/^\s+(\w+):\s*([\d.]+)/);
        if (kv) ratings[kv[1]] = parseFloat(kv[2]);
      }
      page.ratings = ratings;
    }
  } catch {
    // Silently ignore — ratings enrichment is best-effort
  }
  return page;
}

function findPage(pages: PageData[], query: string): PageData | null {
  let page = pages.find(p => p.id === query);
  if (page) return enrichWithFrontmatterRatings(page);

  const matches = pages.filter(p =>
    p.id.includes(query) || p.title.toLowerCase().includes(query.toLowerCase())
  );
  if (matches.length === 1) return enrichWithFrontmatterRatings(matches[0]);
  if (matches.length > 1) {
    console.log('Multiple matches found:');
    matches.slice(0, 10).forEach(p => console.log(`  - ${p.id} (${p.title})`));
    process.exit(1);
  }
  return null;
}

function getFilePath(pagePath: string): string {
  const cleanPath = pagePath.replace(/^\/|\/$/g, '');
  return path.join(ROOT, 'content/docs', cleanPath + '.mdx');
}

function getImportPath(): string {
  return '@components/wiki';
}

// Run Claude with tools
async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const {
    model = MODELS.sonnet,
    maxTokens = 16000,
    tools = [],
    systemPrompt = ''
  } = options;

  const messages: MessageParam[] = [{ role: 'user', content: prompt }];
  let response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: tools as Anthropic.Messages.Tool[],
    messages
  });

  // Handle tool use loop
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      try {
        const input = (toolUse.input ?? {}) as Record<string, string>;
        if (toolUse.name === 'web_search') {
          result = await executeWebSearch(input.query);
        } else if (toolUse.name === 'scry_search') {
          result = await executeScrySearch(input.query, input.table);
        } else if (toolUse.name === 'read_file') {
          const resolvedPath = path.resolve(input.path);
          if (!resolvedPath.startsWith(ROOT)) {
            result = 'Access denied: path must be within project root';
          } else {
            result = fs.readFileSync(resolvedPath, 'utf-8');
          }
        } else {
          result = `Unknown tool: ${toolUse.name}`;
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        result = `Error: ${error.message}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: tools as Anthropic.Messages.Tool[],
      messages
    });
  }

  // Extract text from response
  const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
}

// Tool implementations
async function executeWebSearch(query: string): Promise<string> {
  // Use Anthropic's web search via a simple agent call
  const response = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 4000,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3
    }],
    messages: [{
      role: 'user',
      content: `Search for: "${query}". Return the top 5 most relevant results with titles, URLs, and brief descriptions.`
    }]
  });

  const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
}

async function executeScrySearch(query: string, table: string = 'mv_eaforum_posts'): Promise<string> {
  const sql = `SELECT title, uri, snippet, original_author, original_timestamp::date as date
    FROM scry.search('${query.replace(/'/g, "''")}', '${table}')
    WHERE title IS NOT NULL AND kind = 'post'
    LIMIT 10`;

  try {
    const response = await fetch('https://api.exopriors.com/v1/scry/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SCRY_PUBLIC_KEY}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    return await response.text();
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return `SCRY search error: ${error.message}`;
  }
}

// Phase: Analyze
async function analyzePhase(page: PageData, directions: string, options: PipelineOptions): Promise<AnalysisResult> {
  log('analyze', 'Starting analysis');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const prompt = `Analyze this wiki page for improvement opportunities.

## Page Info
- ID: ${page.id}
- Title: ${page.title}
- Quality: ${page.quality || 'N/A'}
- Importance: ${page.importance || 'N/A'}
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

  // Parse JSON from result
  let analysis: AnalysisResult;
  try {
    // Try to extract JSON from the response
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

// Phase: Research
async function researchPhase(page: PageData, analysis: AnalysisResult, options: PipelineOptions): Promise<ResearchResult> {
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

// Phase: Improve
async function improvePhase(page: PageData, analysis: AnalysisResult, research: ResearchResult, directions: string, options: PipelineOptions): Promise<string> {
  log('improve', 'Starting improvements');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');
  const importPath = getImportPath();

  // Build objectivity context from previous ratings
  const objectivityContext = buildObjectivityContext(page, analysis);

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
- EntityLinks: <EntityLink id="entity-id">Display Text</EntityLink>
- Escape dollar signs: \\$100M not $100M
- Import from: '${importPath}'

### Quality Standards
- Add citations from the research sources
- Replace vague claims with specific numbers
- Add EntityLinks for related concepts
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

### Output Format
Output the COMPLETE improved MDX file content. Include all frontmatter and content.
Do not output markdown code blocks - output the raw MDX directly.

Start your response with "---" (the frontmatter delimiter).`;

  const result = await runAgent(prompt, {
    model: options.improveModel || MODELS.sonnet,
    maxTokens: 16000
  });

  // Extract the MDX content
  let improvedContent: string = result;
  if (!improvedContent.startsWith('---')) {
    // Try to extract MDX from markdown code block
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

  // Remove quality field - must be set by grade-content.ts only
  improvedContent = improvedContent.replace(
    /^quality:\s*\d+\s*\n/m,
    ''
  );

  writeTemp(page.id, 'improved.mdx', improvedContent);
  log('improve', 'Complete');
  return improvedContent;
}

// Phase: Review
async function reviewPhase(page: PageData, improvedContent: string, options: PipelineOptions): Promise<ReviewResult> {
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

// Phase: Validate
async function validatePhase(page: PageData, improvedContent: string, options: PipelineOptions): Promise<ValidationResult> {
  log('validate', 'Running validation checks...');

  const filePath = getFilePath(page.path);
  const originalContent = fs.readFileSync(filePath, 'utf-8');

  // Write improved content to the actual file so validators check the new version
  fs.writeFileSync(filePath, improvedContent);

  const issues: { critical: ValidationIssue[]; quality: ValidationIssue[] } = {
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
    // Restore original content — the pipeline applies changes later if approved
    fs.writeFileSync(filePath, originalContent);
  }

  writeTemp(page.id, 'validation-results.json', issues);

  const hasCritical: boolean = issues.critical.length > 0;
  log('validate', `Complete (critical: ${issues.critical.length}, quality: ${issues.quality.length})`);

  return { issues, hasCritical, improvedContent };
}

// Phase: Gap Fill (deep tier only)
async function gapFillPhase(page: PageData, improvedContent: string, review: ReviewResult, options: PipelineOptions): Promise<string> {
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
      fixedContent = improvedContent; // Keep original if extraction fails
    }
  }

  writeTemp(page.id, 'final.mdx', fixedContent);
  log('gap-fill', 'Complete');
  return fixedContent;
}

// Main pipeline
async function runPipeline(pageId: string, options: PipelineOptions = {}): Promise<PipelineResults> {
  const { tier = 'standard', directions = '', dryRun = false } = options;
  const tierConfig = TIERS[tier];

  if (!tierConfig) {
    console.error(`Unknown tier: ${tier}. Available: ${Object.keys(TIERS).join(', ')}`);
    process.exit(1);
  }

  // Find page
  const pages = loadPages();
  const page = findPage(pages, pageId);
  if (!page) {
    console.error(`Page not found: ${pageId}`);
    console.log('Try: node crux/authoring/page-improver.ts -- --list');
    process.exit(1);
  }

  const filePath = getFilePath(page.path);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Improving: "${page.title}"`);
  console.log(`Tier: ${tierConfig.name} (${tierConfig.cost})`);
  console.log(`Phases: ${tierConfig.phases.join(' → ')}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  const startTime: number = Date.now();
  let analysis: AnalysisResult | undefined, research: ResearchResult | undefined, improvedContent: string | undefined, review: ReviewResult | undefined;

  // Run phases based on tier
  for (const phase of tierConfig.phases) {
    const phaseStart: number = Date.now();

    switch (phase) {
      case 'analyze':
        analysis = await analyzePhase(page, directions, options);
        break;

      case 'research':
        research = await researchPhase(page, analysis!, { ...options, deep: false });
        break;

      case 'research-deep':
        research = await researchPhase(page, analysis!, { ...options, deep: true });
        break;

      case 'improve':
        improvedContent = await improvePhase(page, analysis!, research || { sources: [] }, directions, options);
        break;

      case 'validate':
        const validation = await validatePhase(page, improvedContent!, options);
        if (validation.hasCritical) {
          log('validate', 'Critical validation issues found - may need manual fixes');
        }
        break;

      case 'gap-fill':
        improvedContent = await gapFillPhase(page, improvedContent!, review || { valid: true, issues: [] }, options);
        break;

      case 'review':
        review = await reviewPhase(page, improvedContent!, options);
        break;
    }

    const phaseDuration: string = ((Date.now() - phaseStart) / 1000).toFixed(1);
    log(phase, `Duration: ${phaseDuration}s`);
  }

  const totalDuration: string = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write final output
  const finalPath = writeTemp(page.id, 'final.mdx', improvedContent!);

  console.log('\n' + '='.repeat(60));
  console.log('Pipeline Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${totalDuration}s`);
  console.log(`Output: ${finalPath}`);

  if (review) {
    console.log(`Quality: ${review.qualityScore || 'N/A'}`);
    if (review.issues?.length > 0) {
      console.log(`Issues: ${review.issues.length}`);
      review.issues.slice(0, 3).forEach(i => console.log(`  - ${i}`));
    }
  }

  if (dryRun) {
    console.log('\nTo apply changes:');
    console.log(`  cp "${finalPath}" "${filePath}"`);
    console.log('\nOr review the diff:');
    console.log(`  diff "${filePath}" "${finalPath}"`);
  } else {
    // Apply changes directly
    fs.copyFileSync(finalPath, filePath);
    console.log(`\nChanges applied to ${filePath}`);

    // Run grading if requested
    if (options.grade) {
      console.log('\nRunning grade-content.ts...');
      try {
        execSync(`${NODE_TSX} crux/authoring/grade-content.ts --page "${page.id}" --apply`, {
          cwd: ROOT,
          stdio: 'inherit'
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Grading failed:', error.message);
      }
    }
  }

  // Save pipeline results
  const results: PipelineResults = {
    pageId: page.id,
    title: page.title,
    tier,
    directions,
    duration: totalDuration,
    phases: tierConfig.phases,
    review,
    outputPath: finalPath
  };
  writeTemp(page.id, 'pipeline-results.json', results);

  return results;
}

// List pages needing improvement
function listPages(pages: PageData[], options: ListOptions = {}): void {
  const { limit = 20, maxQuality = 80, minImportance = 30 } = options;

  const candidates = pages
    .filter(p => p.quality && p.quality <= maxQuality)
    .filter(p => p.importance && p.importance >= minImportance)
    .filter(p => !p.path.includes('/models/'))
    .map(p => ({
      id: p.id,
      title: p.title,
      quality: p.quality!,
      importance: p.importance!,
      gap: p.importance! - p.quality!
    }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, limit);

  console.log(`\nPages needing improvement (Q<=${maxQuality}, Imp>=${minImportance}):\n`);
  console.log('| # | Q | Imp | Gap | Page |');
  console.log('|---|---|-----|-----|------|');
  candidates.forEach((p, i) => {
    console.log(`| ${i + 1} | ${p.quality} | ${p.importance} | ${p.gap > 0 ? '+' : ''}${p.gap} | ${p.title} (${p.id}) |`);
  });
  console.log(`\nRun: node crux/authoring/page-improver.ts -- <page-id> --directions "your directions"`);
}

// Parse arguments (bare '--' is skipped so flags still work after it)
function parseArgs(args: string[]): ParsedArgs {
  const opts: ParsedArgs = { _positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      (opts._positional as string[]).push(args[i]);
    }
  }
  return opts;
}

// Main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (args.length === 0 || opts.help || opts.h) {
    console.log(`
Page Improvement Pipeline v2

Multi-phase improvement with SCRY research and specific directions.

Usage:
  node crux/authoring/page-improver.ts -- <page-id> [options]
  node crux/authoring/page-improver.ts -- --list

Options:
  --directions "..."   Specific improvement directions
  --tier <tier>        polish ($2-3), standard ($5-8), deep ($10-15)
  --apply              Apply changes directly (don't just preview)
  --grade              Run grade-content.ts after applying (requires --apply)
  --list               List pages needing improvement
  --limit N            Limit list results (default: 20)

Tiers:
  polish    Quick single-pass, no research
  standard  Light research + improve + review (default)
  deep      Full SCRY + web research, gap filling

Examples:
  node crux/authoring/page-improver.ts -- open-philanthropy --directions "add 2024 grants"
  node crux/authoring/page-improver.ts -- far-ai --tier deep --directions "add publications"
  node crux/authoring/page-improver.ts -- cea --tier polish
  node crux/authoring/page-improver.ts -- --list --limit 30
`);
    return;
  }

  if (opts.list) {
    const pages = loadPages();
    listPages(pages, { limit: parseInt(opts.limit as string) || 20 });
    return;
  }

  const pageId = (opts._positional as string[])[0];
  if (!pageId) {
    console.error('Error: No page ID provided');
    console.error('Try: node crux/authoring/page-improver.ts -- --list');
    process.exit(1);
  }

  await runPipeline(pageId, {
    tier: (opts.tier as string) || 'standard',
    directions: (opts.directions as string) || '',
    dryRun: !opts.apply,
    grade: !!(opts.grade && opts.apply)  // Only grade if --apply is also set
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
