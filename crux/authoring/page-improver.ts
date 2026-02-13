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
import { buildEntityLookupForContent } from '../lib/entity-lookup.ts';
import { convertSlugsToNumericIds } from './creator/deployment.ts';
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
  'unsourced-biographical-claims',
  'evaluative-flattery',
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
const anthropic = new Anthropic({ timeout: 10 * 60 * 1000 });

// ---------------------------------------------------------------------------
// Resilience helpers: retry, streaming, progress heartbeat
// ---------------------------------------------------------------------------

/** Retry an async fn with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 2, label = 'API call' }: { maxRetries?: number; label?: string } = {}
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const isRetryable =
        error.message.includes('timeout') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('socket hang up') ||
        error.message.includes('overloaded') ||
        error.message.includes('529') ||
        error.message.includes('rate_limit');
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
      log('retry', `${label} failed (${error.message.slice(0, 80)}), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

/** Start a heartbeat timer that logs a dot every `intervalSec` seconds. Returns a stop function. */
function startHeartbeat(phase: string, intervalSec = 30): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stderr.write(`[${formatTime()}] [${phase}] … still running (${elapsed}s)\n`);
  }, intervalSec * 1000);
  return () => clearInterval(timer);
}

/**
 * Streaming wrapper for Anthropic API calls.
 * Uses server-sent events to keep the connection alive through proxies.
 */
async function streamingCreate(
  params: Parameters<typeof anthropic.messages.create>[0]
): Promise<Anthropic.Messages.Message> {
  const stream = anthropic.messages.stream(params as any);
  return await stream.finalMessage();
}

// ---------------------------------------------------------------------------
// YAML frontmatter repair
// ---------------------------------------------------------------------------

/**
 * Validate and repair YAML frontmatter after model generation.
 * Catches common LLM errors like merged lines, missing newlines, etc.
 */
function repairFrontmatter(content: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  let fm = fmMatch[2];
  const rest = content.slice(fmMatch[0].length);

  // Fix 1: Lines where a YAML key:value is merged with another key on the same line.
  // e.g. "  diagrams: 1clusters: [...]" → "  diagrams: 1\nclusters: [...]"
  // This happens when the LLM drops the newline between frontmatter fields.
  // IMPORTANT: Use [ \t] (not \s) to avoid matching across newlines, which would
  // corrupt multi-line YAML structures (e.g., splitting "wordCount" into "w\nordCount").
  fm = fm.replace(/^([ \t]+\w+:[ \t]*\S+?)([a-zA-Z_][\w]*:[ \t])/gm, '$1\n$2');

  // Fix 2: Remove backslash-escaping from YAML string values.
  // The LLM often escapes dollar signs (\$) in frontmatter YAML strings, but
  // YAML doesn't need escaping — only MDX body content does. \$ in YAML causes
  // MDX compilation errors like "Invalid escape sequence \$".
  fm = fm.replace(/^(\w+:.*)\\\$/gm, '$1$');
  fm = fm.replace(/^([ \t]+\w+:.*)\\\$/gm, '$1$');

  // Fix 3: Top-level keys that got incorrectly indented under a block.
  // e.g. "  clusters:" should be "clusters:" if it's a known top-level key.
  const knownSubKeys = new Set([
    'wordCount', 'citations', 'tables', 'diagrams', // metrics sub-keys
    'novelty', 'rigor', 'actionability', 'completeness', // ratings sub-keys
    'objectivity', 'focus', 'concreteness',
    'order', 'label', // sidebar sub-keys
  ]);
  const topLevelKeys = new Set([
    'title', 'description', 'sidebar', 'quality', 'importance', 'lastEdited',
    'update_frequency', 'llmSummary', 'ratings', 'metrics', 'clusters',
    'draft', 'aliases', 'redirects', 'tags',
  ]);
  const lines = fm.split('\n');
  const repaired: string[] = [];
  for (const line of lines) {
    const indentedKeyMatch = line.match(/^(\s{2,})(\w+):\s/);
    if (indentedKeyMatch) {
      const key = indentedKeyMatch[2];
      if (topLevelKeys.has(key) && !knownSubKeys.has(key)) {
        // This top-level key got incorrectly indented — dedent it
        repaired.push(line.replace(/^\s+/, ''));
        continue;
      }
    }
    repaired.push(line);
  }
  fm = repaired.join('\n');

  return '---\n' + fm + '\n---' + rest;
}

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

// ---------------------------------------------------------------------------
// Post-processing: strip redundant Related Pages sections
// ---------------------------------------------------------------------------

const RELATED_SECTION_PATTERNS = [
  /^## Related Pages\s*$/,
  /^## See Also\s*$/,
  /^## Related Content\s*$/,
];

/**
 * Remove manual "Related Pages" / "See Also" / "Related Content" sections.
 * These are now rendered automatically by the RelatedPages React component.
 * Also cleans up unused Backlinks imports.
 */
function stripRelatedPagesSections(content: string): string {
  const lines = content.split('\n');

  // Find all ## heading indices
  const sectionStarts: { index: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i].trimEnd())) {
      sectionStarts.push({ index: i, heading: lines[i].trimEnd() });
    }
  }

  // Identify sections to remove (work backwards)
  const rangesToRemove: { start: number; end: number }[] = [];
  for (const { index, heading } of sectionStarts) {
    if (!RELATED_SECTION_PATTERNS.some(p => p.test(heading))) continue;

    const nextSection = sectionStarts.find(s => s.index > index);
    let endIndex = nextSection ? nextSection.index : lines.length;
    while (endIndex > index && lines[endIndex - 1].trim() === '') endIndex--;

    // Check for preceding --- separator
    let startIndex = index;
    let checkIdx = index - 1;
    while (checkIdx >= 0 && lines[checkIdx].trim() === '') checkIdx--;
    if (checkIdx >= 0 && /^---\s*$/.test(lines[checkIdx])) startIndex = checkIdx;
    while (startIndex > 0 && lines[startIndex - 1].trim() === '') startIndex--;

    rangesToRemove.push({ start: startIndex, end: endIndex });
  }

  // Remove in reverse order
  rangesToRemove.sort((a, b) => b.start - a.start);
  for (const { start, end } of rangesToRemove) {
    lines.splice(start, end - start);
  }

  let result = lines.join('\n');

  // Clean up Backlinks import if no <Backlinks usage remains
  const contentWithoutImports = result.replace(/^import\s.*$/gm, '');
  if (!/<Backlinks[\s/>]/.test(contentWithoutImports)) {
    result = result.replace(
      /^(import\s*\{)([^}]*)(}\s*from\s*['"]@components\/wiki['"];?\s*)$/gm,
      (match, prefix, imports, suffix) => {
        const importList = imports.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (!importList.includes('Backlinks')) return match;
        const filtered = importList.filter((s: string) => s !== 'Backlinks');
        if (filtered.length === 0) return '';
        return `${prefix}${filtered.join(', ')}${suffix}`;
      }
    );
    result = result.replace(/\n{3,}/g, '\n\n');
  }

  // Ensure file ends with single newline
  result = result.replace(/\n{3,}$/g, '\n');
  if (!result.endsWith('\n')) result += '\n';

  return result;
}

// ---------------------------------------------------------------------------
// Triage: cheap news-check to auto-select update tier
// ---------------------------------------------------------------------------

export interface TriageResult {
  pageId: string;
  title: string;
  lastEdited: string;
  recommendedTier: 'skip' | 'polish' | 'standard' | 'deep';
  reason: string;
  newDevelopments: string[];
  estimatedCost: string;
  triageCost: string;
}

/**
 * Cheap pre-check (~$0.10-0.20) to determine if a page needs updating and at what tier.
 *
 * Uses Haiku + web search + SCRY to check for new developments since the page's
 * last edit date, then recommends skip/polish/standard/deep.
 *
 * Cost breakdown:
 *   - Web search: ~$0.05 (Sonnet web search, 1 query)
 *   - SCRY search: free
 *   - Haiku classification: ~$0.01-0.02
 *   Total: ~$0.06-0.10 per page
 */
export async function triagePhase(page: PageData, lastEdited: string): Promise<TriageResult> {
  log('triage', `Checking for news since ${lastEdited}: "${page.title}"`);

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  // Extract frontmatter summary for context (first 500 chars of content after frontmatter)
  const contentAfterFm = currentContent.replace(/^---[\s\S]*?---\n/, '');
  const contentPreview = contentAfterFm.slice(0, 500);

  // Run web search and SCRY search in parallel
  const searchQuery = `${page.title} developments news ${lastEdited} to ${new Date().toISOString().slice(0, 10)}`;
  const scryQuery = page.title;

  const [webResults, scryResults] = await Promise.all([
    executeWebSearch(searchQuery).catch(err => `Web search failed: ${err.message}`),
    executeScrySearch(scryQuery).catch(err => `SCRY search failed: ${err.message}`),
  ]);

  // Use Haiku to classify — cheap and fast
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

  // Validate tier
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
export function loadPages(): PageData[] {
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

export function findPage(pages: PageData[], query: string): PageData | null {
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

export function getFilePath(pagePath: string): string {
  const cleanPath = pagePath.replace(/^\/|\/$/g, '');
  return path.join(ROOT, 'content/docs', cleanPath + '.mdx');
}

function getImportPath(): string {
  return '@components/wiki';
}

// Run Claude with tools (streaming + retry + heartbeat)
async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const {
    model = MODELS.sonnet,
    maxTokens = 16000,
    tools = [],
    systemPrompt = ''
  } = options;

  const messages: MessageParam[] = [{ role: 'user', content: prompt }];

  const makeRequest = (msgs: MessageParam[]) =>
    withRetry(
      () => streamingCreate({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: tools as Anthropic.Messages.Tool[],
        messages: msgs
      }),
      { label: `runAgent(${model}, ${maxTokens} tokens)` }
    );

  const stopHeartbeat = startHeartbeat('api', 30);
  let response: Anthropic.Messages.Message;
  try {
    response = await makeRequest(messages);
  } finally {
    stopHeartbeat();
  }

  // Handle tool use loop
  let toolTurns = 0;
  const MAX_TOOL_TURNS = 10;
  while (response.stop_reason === 'tool_use' && toolTurns < MAX_TOOL_TURNS) {
    toolTurns++;
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

    const stopLoop = startHeartbeat('api-tool-loop', 30);
    try {
      response = await makeRequest(messages);
    } finally {
      stopLoop();
    }
  }
  if (toolTurns >= MAX_TOOL_TURNS) {
    log('api', `Warning: hit tool turn limit (${MAX_TOOL_TURNS}), stopping agent loop`);
  }

  // Extract text from response
  const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
}

// Tool implementations
async function executeWebSearch(query: string): Promise<string> {
  // Use Anthropic's web search via streaming (prevents proxy timeouts)
  const response = await withRetry(
    () => streamingCreate({
      model: MODELS.sonnet,
      max_tokens: 4000,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3
      } as any],
      messages: [{
        role: 'user',
        content: `Search for: "${query}". Return the top 5 most relevant results with titles, URLs, and brief descriptions.`
      }]
    }),
    { label: 'web_search' }
  );

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

// Compute actual metrics from MDX content and sync into frontmatter
function syncFrontmatterMetrics(content: string): string {
  // Split frontmatter from body
  const fmMatch = content.match(/^(---\n[\s\S]*?\n---)\n([\s\S]*)$/);
  if (!fmMatch) return content;
  let frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Count words in body (excluding MDX components, imports, frontmatter)
  const textOnly = body
    .replace(/^import\s.*/gm, '')              // Remove imports
    .replace(/<[^>]+\/>/g, '')                  // Remove self-closing components
    .replace(/<[A-Z]\w+[^>]*>[\s\S]*?<\/[A-Z]\w+>/g, '') // Remove component blocks
    .replace(/\[.*?\]\(.*?\)/g, (m) => m.replace(/\(.*?\)/, '')) // Keep link text only
    .replace(/[|*#`_\-\[\]>]/g, ' ')           // Remove markdown syntax
    .replace(/\^\[\d+\]/g, '')                  // Remove footnote refs
    .replace(/\[\^\d+\]:/g, '');                // Remove footnote defs
  const wordCount = textOnly.split(/\s+/).filter(w => w.length > 0).length;

  // Count footnote citations ([^N] references in body, not definitions)
  const citationRefs = new Set(body.match(/\[\^\d+\]/g) || []);
  const citations = citationRefs.size;

  // Count markdown tables (lines starting with |)
  const tableHeaderLines = (body.match(/^\|.*\|.*\|$/gm) || [])
    .filter(line => !line.match(/^\|[\s\-:|]+\|$/)); // Exclude separator lines
  // Each table has a header row; count unique tables by checking for separator after header
  const tableSeparators = (body.match(/^\|[\s\-:|]+\|$/gm) || []);
  const tables = tableSeparators.length;

  // Count Mermaid diagrams
  const diagrams = (body.match(/<Mermaid\s/g) || []).length;

  // Update metrics in frontmatter
  // The trailing \n is critical — without it the last metrics line merges with the next key.
  // Use [ \t]+ (not \s+) in the sub-key pattern to avoid matching across newlines.
  const metricsBlock = `metrics:\n  wordCount: ${wordCount}\n  citations: ${citations}\n  tables: ${tables}\n  diagrams: ${diagrams}\n`;
  if (frontmatter.match(/^metrics:\s*\n(?:[ \t]+\w+:[ \t]*[\d.]+\n?)*/m)) {
    frontmatter = frontmatter.replace(
      /^metrics:\s*\n(?:[ \t]+\w+:[ \t]*[\d.]+\n?)*/m,
      metricsBlock
    );
  }

  // Safety: run frontmatter repair to catch any YAML corruption
  const reassembled = frontmatter + '\n' + body;
  return repairFrontmatter(reassembled);
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

  // Build entity lookup table for numeric ID usage
  log('improve', 'Building entity lookup table...');
  const entityLookup = buildEntityLookupForContent(currentContent, ROOT);
  const entityLookupCount = entityLookup.split('\n').filter(Boolean).length;
  log('improve', `  Found ${entityLookupCount} relevant entities for lookup`);

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

  // Repair any YAML frontmatter corruption from model output
  improvedContent = repairFrontmatter(improvedContent);

  // Strip any "Related Pages" / "See Also" / "Related Content" sections
  // (now rendered automatically by the RelatedPages component)
  improvedContent = stripRelatedPagesSections(improvedContent);

  // Convert any remaining slug-based EntityLink IDs to numeric (E##) format.
  // The LLM should use E## IDs from the lookup table, but this is a safety net
  // in case it falls back to slug-based IDs from the training data.
  const { content: convertedContent, converted: slugsConverted } = convertSlugsToNumericIds(improvedContent, ROOT);
  if (slugsConverted > 0) {
    log('improve', `  Converted ${slugsConverted} remaining slug-based EntityLink ID(s) to E## format`);
    improvedContent = convertedContent;
  }

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
  let fixedContent = improvedContent;

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

    // Validate EntityLink IDs against known pages/entities
    log('validate', 'Checking EntityLink IDs against registry...');
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const entityLinkIds = [...fileContent.matchAll(/<EntityLink\s+id="([^"]+)"/g)].map(m => m[1]);
      if (entityLinkIds.length > 0) {
        const pages = loadPages();
        const pageIds = new Set(pages.map(p => p.id));

        // Also load id-registry so we can resolve E## → slug
        let idRegistry: Record<string, string> = {};
        try {
          const raw = fs.readFileSync(path.join(ROOT, 'data/id-registry.json'), 'utf-8');
          idRegistry = JSON.parse(raw).entities || {};
        } catch { /* ignore */ }

        const invalidIds = entityLinkIds.filter(id => {
          // Accept E## format — resolve to slug and check
          if (/^E\d+$/i.test(id)) {
            const slug = idRegistry[id.toUpperCase()];
            return !slug; // invalid only if E## doesn't exist in registry
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

    // Auto-fix escaping and formatting issues before final validation
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
      // Re-read the auto-fixed content
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
    // Restore original content — the pipeline applies changes later if approved
    fs.writeFileSync(filePath, originalContent);
  }

  writeTemp(page.id, 'validation-results.json', issues);

  const hasCritical: boolean = issues.critical.length > 0;
  log('validate', `Complete (critical: ${issues.critical.length}, quality: ${issues.quality.length})`);

  return { issues, hasCritical, improvedContent: fixedContent };
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

  // Repair any YAML frontmatter corruption from model output
  fixedContent = repairFrontmatter(fixedContent);

  writeTemp(page.id, 'final.mdx', fixedContent);
  log('gap-fill', 'Complete');
  return fixedContent;
}

// Main pipeline
export async function runPipeline(pageId: string, options: PipelineOptions = {}): Promise<PipelineResults> {
  let { tier = 'standard', directions = '', dryRun = false } = options;

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

  // Handle triage tier: run news check to auto-select the real tier
  let triageResult: TriageResult | undefined;
  if (tier === 'triage') {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/lastEdited:\s*["']?(\d{4}-\d{2}-\d{2})["']?/);
    const lastEdited = fmMatch?.[1] || 'unknown';
    triageResult = await triagePhase(page, lastEdited);

    if (triageResult.recommendedTier === 'skip') {
      console.log(`\nTriage: SKIP — ${triageResult.reason}`);
      return {
        pageId: page.id,
        title: page.title,
        tier: 'skip',
        directions,
        duration: '0',
        phases: ['triage'],
        review: undefined,
        outputPath: '',
      };
    }

    tier = triageResult.recommendedTier;
    // If triage found specific new developments, add them to directions
    if (triageResult.newDevelopments.length > 0) {
      const triageDirections = `New developments to incorporate: ${triageResult.newDevelopments.join('; ')}`;
      directions = directions ? `${directions}\n\n${triageDirections}` : triageDirections;
    }
    log('triage', `Auto-selected tier: ${tier}`);
  }

  const tierConfig = TIERS[tier];
  if (!tierConfig) {
    console.error(`Unknown tier: ${tier}. Available: ${Object.keys(TIERS).join(', ')}, triage`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Improving: "${page.title}"`);
  if (triageResult) {
    console.log(`Triage: ${triageResult.reason}`);
  }
  console.log(`Tier: ${tierConfig.name} (${tierConfig.cost})`);
  console.log(`Phases: ${tierConfig.phases.join(' → ')}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  const startTime: number = Date.now();
  let analysis: AnalysisResult | undefined, research: ResearchResult | undefined, improvedContent: string | undefined, review: ReviewResult | undefined;

  // Run phases based on tier
  for (const phase of tierConfig.phases) {
    const phaseStart: number = Date.now();
    const stopPhaseHeartbeat = startHeartbeat(phase, 60);

    try { switch (phase) {
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
        // Sync frontmatter metrics (wordCount, citations, tables, diagrams) with actual content
        improvedContent = syncFrontmatterMetrics(improvedContent);
        // Warn about unverified citations in tiers without research
        if (tier === 'polish' && !research?.sources?.length) {
          const footnoteCount = new Set(improvedContent.match(/\[\^\d+\]/g) || []).size;
          if (footnoteCount > 0) {
            log('improve', `⚠ ${footnoteCount} footnote citations added without web research — citations are LLM-generated and should be verified`);
          }
        }
        // Extra hallucination warnings for person/org pages
        if (page.path.includes('/people/') || page.path.includes('/organizations/')) {
          log('improve', '⚠ PERSON/ORG PAGE — high hallucination risk. Verifying biographical claims...');
          const bioPatterns = [
            { pattern: /\b(?:joined|left|departed)\b.*\b(?:in|since)\s+\d{4}\b/gi, label: 'employment dates' },
            { pattern: /\bPhD|Ph\.D\.|doctorate|master's|bachelor's|degree\b.*\b(?:from|at)\s+[A-Z]/gi, label: 'education claims' },
            { pattern: /\b(?:founded|co-founded|established)\b.*\b(?:in|circa)\s+\d{4}\b/gi, label: 'founding dates' },
          ];
          let bioWarnings = 0;
          const lines = improvedContent.split('\n');
          for (const line of lines) {
            // Skip lines that already have citations
            if (/\[\^\d+\]|<R\s+id=|\]\(https?:\/\//.test(line)) continue;
            for (const { pattern, label } of bioPatterns) {
              pattern.lastIndex = 0;
              if (pattern.test(line)) {
                bioWarnings++;
                if (bioWarnings <= 5) {
                  log('improve', `  ⚠ Unsourced ${label}: "${line.trim().slice(0, 70)}..."`);
                }
              }
            }
          }
          if (bioWarnings > 5) {
            log('improve', `  ... and ${bioWarnings - 5} more unsourced biographical claims`);
          }
          if (bioWarnings > 0) {
            log('improve', `  TOTAL: ${bioWarnings} biographical claims without citations — review these carefully`);
            if (tier === 'polish') {
              log('improve', '  Consider using --tier=standard to add research-backed citations');
            }
          }
        }
        break;

      case 'validate': {
        const validation = await validatePhase(page, improvedContent!, options);
        // Use auto-fixed content from validate phase (escaping, markdown fixes)
        improvedContent = validation.improvedContent;
        if (validation.hasCritical) {
          log('validate', 'Critical validation issues found - may need manual fixes');
        }
        break;
      }

      case 'gap-fill':
        improvedContent = await gapFillPhase(page, improvedContent!, review || { valid: true, issues: [] }, options);
        break;

      case 'review':
        review = await reviewPhase(page, improvedContent!, options);
        break;
    }

    } finally {
      stopPhaseHeartbeat();
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
// Supports both --key=value and --key value formats
function parseArgs(args: string[]): ParsedArgs {
  const opts: ParsedArgs = { _positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    if (args[i].startsWith('--')) {
      const raw = args[i].slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value format
        const key = raw.slice(0, eqIdx);
        const value = raw.slice(eqIdx + 1);
        opts[key] = value;
      } else {
        // --key value or --flag format
        const key = raw;
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
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
  --tier <tier>        polish ($2-3), standard ($5-8), deep ($10-15), or triage (auto)
  --apply              Apply changes directly (don't just preview)
  --grade              Run grade-content.ts after applying (requires --apply)
  --triage             Run news-check triage only (no improvement)
  --list               List pages needing improvement
  --limit N            Limit list results (default: 20)

Tiers:
  polish    Quick single-pass, no research
  standard  Light research + improve + review (default)
  deep      Full SCRY + web research, gap filling
  triage    Auto-select tier via cheap news check (~$0.08)

Examples:
  node crux/authoring/page-improver.ts -- open-philanthropy --directions "add 2024 grants"
  node crux/authoring/page-improver.ts -- far-ai --tier deep --directions "add publications"
  node crux/authoring/page-improver.ts -- cea --tier polish
  node crux/authoring/page-improver.ts -- cea --triage           # Check if update needed
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

  // Triage-only mode: just check if update is needed
  if (opts.triage) {
    const pages = loadPages();
    const page = findPage(pages, pageId);
    if (!page) {
      console.error(`Page not found: ${pageId}`);
      process.exit(1);
    }
    const filePath = getFilePath(page.path);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/lastEdited:\s*["']?(\d{4}-\d{2}-\d{2})["']?/);
    const lastEdited = fmMatch?.[1] || 'unknown';
    const result = await triagePhase(page, lastEdited);
    console.log('\nTriage Result:');
    console.log(JSON.stringify(result, null, 2));
    return;
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
