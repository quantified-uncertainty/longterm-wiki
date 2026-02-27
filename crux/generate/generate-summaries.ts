#!/usr/bin/env node

/**
 * Summary Generation Script
 *
 * Uses Anthropic API to generate summaries of articles.
 * Reads article content directly from MDX files and stores results
 * in the wiki-server PostgreSQL database.
 *
 * Usage:
 *   node crux/generate/generate-summaries.ts [options]
 *
 * Options:
 *   --batch <n>          Number of items to process (default: 10)
 *   --concurrency <n>    Number of parallel API calls (default: 3)
 *   --model <model>      Model to use: 'haiku', 'sonnet', 'opus' (default: haiku)
 *   --id <id>            Summarize a specific entity by ID
 *   --dry-run            Show what would be summarized without making API calls
 *   --verbose            Show detailed output
 *
 * Examples:
 *   node crux/generate/generate-summaries.ts --batch 100 --concurrency 5
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Required API key (from .env file)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { upsertSummary } from '../lib/wiki-server/summaries.ts';
import { getColors } from '../lib/output.ts';
import { createClient, resolveModel, sleep } from '../lib/anthropic.ts';
import { extractText } from '../lib/llm.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { basename } from 'path';

interface SummaryResult {
  oneLiner: string;
  summary: string;
  review?: string;
  keyPoints: string[];
  keyClaims: Array<{ claim: string; value: string }>;
  tokensUsed: number;
}

interface Article {
  id: string;
  title?: string;
  content: string;
}

interface ProcessResult {
  status: 'fulfilled' | 'rejected';
  item: Article;
  result?: SummaryResult;
  error?: Error;
}

interface ProcessStats {
  results: ProcessResult[];
  completed: number;
  failed: number;
  totalTokens: number;
}

import { parseCliArgs } from '../lib/cli.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';

const parsed = parseCliArgs(process.argv.slice(2));

const BATCH_SIZE = parseInt((parsed.batch as string) || '10');
const MODEL_NAME = (parsed.model as string) || 'haiku';
const CONCURRENCY = parseInt((parsed.concurrency as string) || '3');
const SPECIFIC_ID = (parsed.id as string) || null;
const DRY_RUN = parsed['dry-run'] === true;
const VERBOSE = parsed.verbose === true;

const MODEL_ID = resolveModel(MODEL_NAME);

const colors = getColors();

// =============================================================================
// ANTHROPIC CLIENT
// =============================================================================

const anthropic = DRY_RUN ? null : createClient();

// =============================================================================
// ARTICLE LOADING (from MDX files directly)
// =============================================================================

/**
 * Extract entity ID from file path
 */
function getEntityIdFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.(mdx|md)$/, '');
  if (name === 'index') {
    const parts = filePath.split('/');
    return parts[parts.length - 2];
  }
  return name;
}

/**
 * Extract plain text content from MDX, removing imports and JSX
 */
function extractTextContent(mdxContent: string): string {
  return mdxContent
    .replace(/^import\s+.*$/gm, '')
    .replace(/<[A-Z][a-zA-Z]*\s*[^>]*\/>/g, '')
    .replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Load a single article from its MDX file.
 */
function loadArticle(id: string): Article | null {
  const filePath = findPageFile(id);
  if (!filePath) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(raw) as { title?: string };
  const body = getContentBody(raw);
  const text = extractTextContent(body);

  return {
    id,
    title: frontmatter.title || id,
    content: text,
  };
}

/**
 * Load all articles from MDX files (replacement for articles.needingSummary).
 */
function loadAllArticles(): Article[] {
  const mdxFiles = findMdxFiles(CONTENT_DIR);
  const articles: Article[] = [];

  for (const filePath of mdxFiles) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const frontmatter = parseFrontmatter(raw) as { title?: string; quality?: number };
      const body = getContentBody(raw);
      const text = extractTextContent(body);
      const entityId = getEntityIdFromPath(filePath);

      if (text.length > 100) {
        articles.push({
          id: entityId,
          title: frontmatter.title || entityId,
          content: text,
        });
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return articles;
}

// =============================================================================
// PROMPTS
// =============================================================================

const ARTICLE_SUMMARY_PROMPT = `You are summarizing an article from an AI safety knowledge base.

Analyze the following article and provide:

1. ONE_LINER: A single sentence (max 25 words) capturing the main point
2. SUMMARY: A 2-3 paragraph summary (150-250 words) covering:
   - What the article is about
   - Key arguments or findings
   - Why it matters for AI safety
3. KEY_POINTS: 3-5 bullet points of the most important takeaways
4. KEY_CLAIMS: Extract any specific claims with numbers, probabilities, or timelines. Format as JSON array of objects with "claim" and "value" fields.

Respond in this exact JSON format:
{
  "oneLiner": "...",
  "summary": "...",
  "keyPoints": ["...", "..."],
  "keyClaims": [{"claim": "...", "value": "..."}, ...]
}

ARTICLE TITLE: {{TITLE}}

ARTICLE CONTENT:
{{CONTENT}}`;

// =============================================================================
// SUMMARY GENERATION
// =============================================================================

/**
 * Call Anthropic API to generate summary
 */
async function generateSummary(prompt: string): Promise<SummaryResult> {
  if (!anthropic) {
    throw new Error('Anthropic client not initialized');
  }

  const response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  const text = extractText(response);
  if (!text) {
    throw new Error('Expected text content block from API response');
  }
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  // Parse JSON response (resilient: handles code fences, truncation, embedded JSON)
  const parsedResult = parseJsonFromLlm(text, 'generate-summaries', (raw, _error) => {
    console.error(`${colors.yellow}Warning: Could not parse response as JSON${colors.reset}`);
    if (VERBOSE) {
      console.error('Response:', raw);
    }
    return {
      oneLiner: raw.slice(0, 200),
      summary: raw,
      keyPoints: [] as string[],
      keyClaims: [] as Array<{ claim: string; value: string }>,
    };
  });
  return { ...parsedResult, tokensUsed };
}

/**
 * Summarize an article
 */
async function summarizeArticle(article: Article): Promise<SummaryResult> {
  // Truncate content if too long (roughly 100K chars = ~25K tokens)
  const maxContentLength = 100000;
  const content = article.content.length > maxContentLength
    ? article.content.slice(0, maxContentLength) + '\n\n[Content truncated...]'
    : article.content;

  const prompt = ARTICLE_SUMMARY_PROMPT
    .replace('{{TITLE}}', article.title || article.id)
    .replace('{{CONTENT}}', content);

  const result = await generateSummary(prompt);

  await upsertSummary({
    entityId: article.id,
    entityType: 'article',
    oneLiner: result.oneLiner,
    summary: result.summary,
    review: result.review ?? null,
    keyPoints: (result.keyPoints as string[]) ?? null,
    keyClaims: result.keyClaims?.map(kc => `${kc.claim}: ${kc.value}`) ?? null,
    model: MODEL_ID,
    tokensUsed: result.tokensUsed,
  });

  return result;
}

// =============================================================================
// PARALLEL PROCESSING
// =============================================================================

/**
 * Process items in parallel batches with rate limiting
 */
async function processInParallel(
  items: Article[],
  processor: (item: Article) => Promise<SummaryResult>,
  concurrency: number,
  onProgress?: (index: number, item: Article, result: SummaryResult | null, error: Error | null) => void
): Promise<ProcessStats> {
  const results: ProcessResult[] = [];
  let completed = 0;
  let failed = 0;
  let totalTokens = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchPromises = batch.map(async (item, batchIndex) => {
      const globalIndex = i + batchIndex;
      try {
        const result = await processor(item);
        completed++;
        totalTokens += result.tokensUsed || 0;
        onProgress?.(globalIndex, item, result, null);
        return { status: 'fulfilled' as const, item, result };
      } catch (err: unknown) {
        failed++;
        const error = err instanceof Error ? err : new Error(String(err));
        onProgress?.(globalIndex, item, null, error);
        return { status: 'rejected' as const, item, error };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Small delay between batches to avoid rate limits
    if (i + concurrency < items.length) {
      await sleep(200);
    }
  }

  return { results, completed, failed, totalTokens };
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log(`${colors.blue}Summary Generator${colors.reset}`);
  console.log(`   Model: ${MODEL_NAME} (${MODEL_ID})`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  if (DRY_RUN) console.log(`   ${colors.yellow}DRY RUN - no API calls${colors.reset}`);
  console.log();

  let items: Article[] = [];

  if (SPECIFIC_ID) {
    const article = loadArticle(SPECIFIC_ID);
    if (!article) {
      console.error(`${colors.red}Article not found: ${SPECIFIC_ID}${colors.reset}`);
      process.exit(1);
    }
    items = [article];
  } else {
    // Load articles from MDX files
    items = loadAllArticles().slice(0, BATCH_SIZE);
  }

  if (items.length === 0) {
    console.log(`${colors.green}No articles need summarization${colors.reset}`);
    process.exit(0);
  }

  console.log(`Found ${items.length} articles to summarize\n`);

  if (DRY_RUN) {
    console.log('Would summarize:');
    for (const item of items) {
      console.log(`  - ${item.title || item.id}`);
    }
    process.exit(0);
  }

  // Progress callback
  const onProgress = (index: number, item: Article, result: SummaryResult | null, error: Error | null): void => {
    const progress = `[${index + 1}/${items.length}]`;
    if (error) {
      console.log(`${colors.cyan}${progress}${colors.reset} ${item.title || item.id}`);
      console.log(`   ${colors.red}Error: ${error.message}${colors.reset}`);
    } else {
      console.log(`${colors.cyan}${progress}${colors.reset} ${item.title || item.id}`);
      if (VERBOSE && result) {
        console.log(`   ${colors.dim}One-liner: ${result.oneLiner}${colors.reset}`);
        console.log(`   ${colors.dim}Tokens: ${result.tokensUsed}${colors.reset}`);
      }
      console.log(`   ${colors.green}Done${colors.reset}`);
    }
  };

  // Process items in parallel
  const { completed, failed, totalTokens } = await processInParallel(
    items,
    summarizeArticle,
    CONCURRENCY,
    onProgress
  );

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${colors.green}Summary generation complete${colors.reset}\n`);
  console.log(`  Successful: ${completed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total tokens used: ${totalTokens.toLocaleString()}`);

  // Estimate cost
  const inputCost = MODEL_NAME === 'haiku' ? 0.00025 : MODEL_NAME === 'sonnet' ? 0.003 : 0.015;
  const estimatedCost = (totalTokens / 1000000) * (inputCost + inputCost * 4); // Rough estimate
  console.log(`  Estimated cost: $${estimatedCost.toFixed(4)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
    process.exit(1);
  });
}
