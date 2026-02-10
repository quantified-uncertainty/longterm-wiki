#!/usr/bin/env node

/**
 * Summary Generation Script
 *
 * Uses Anthropic API to generate summaries of articles and sources.
 * Stores results in the knowledge database.
 *
 * Usage:
 *   node tooling/generate/generate-summaries.mjs [options]
 *
 * Options:
 *   --type <type>        Entity type to summarize: 'articles' or 'sources' (default: articles)
 *   --batch <n>          Number of items to process (default: 10)
 *   --concurrency <n>    Number of parallel API calls (default: 3)
 *   --model <model>      Model to use: 'haiku', 'sonnet', 'opus' (default: haiku)
 *   --resummary          Re-summarize items that have changed since last summary
 *   --id <id>            Summarize a specific entity by ID
 *   --dry-run            Show what would be summarized without making API calls
 *   --verbose            Show detailed output
 *
 * Examples:
 *   node tooling/generate/generate-summaries.mjs --batch 100 --concurrency 5
 *   node tooling/generate/generate-summaries.mjs --type sources --batch 50 --concurrency 10
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Required API key (from .env file)
 */

import { articles, sources, summaries } from '../lib/knowledge-db.mjs';
import { getColors } from '../lib/output.mjs';
import { createClient, resolveModel, sleep } from '../lib/anthropic.mjs';

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return defaultValue;
  return args[index + 1] || defaultValue;
}

const TYPE = getArg('type', 'articles');
const BATCH_SIZE = parseInt(getArg('batch', '10'));
const MODEL_NAME = getArg('model', 'haiku');
const CONCURRENCY = parseInt(getArg('concurrency', '3'));
const RESUMMARY = args.includes('--resummary');
const SPECIFIC_ID = getArg('id', null);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

const MODEL_ID = resolveModel(MODEL_NAME);

const colors = getColors();

// =============================================================================
// ANTHROPIC CLIENT
// =============================================================================

const anthropic = DRY_RUN ? null : createClient();

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

const SOURCE_SUMMARY_PROMPT = `You are summarizing a source document referenced in an AI safety knowledge base.

Analyze the following source and provide:

1. ONE_LINER: A single sentence (max 25 words) capturing the main contribution
2. SUMMARY: A 1-2 sentence brief summary for display in tables/lists
3. REVIEW: A {{REVIEW_LENGTH}} in-depth review covering:
   - Main argument or contribution
   - Methodology and key findings
   - Strengths and limitations
   - Implications for AI safety
   - How it relates to other work in the field
4. KEY_POINTS: 2-4 bullet points of the most important takeaways
5. KEY_CLAIMS: Extract any specific claims with numbers, probabilities, or timelines. Format as JSON array.

Respond in this exact JSON format:
{
  "oneLiner": "...",
  "summary": "...",
  "review": "...",
  "keyPoints": ["...", "..."],
  "keyClaims": [{"claim": "...", "value": "..."}, ...]
}

SOURCE TITLE: {{TITLE}}
SOURCE TYPE: {{TYPE}}
AUTHORS: {{AUTHORS}}
YEAR: {{YEAR}}

CONTENT:
{{CONTENT}}`;

/**
 * Get review length instruction based on importance
 */
function getReviewLengthInstruction(importance) {
  if (importance >= 70) {
    return '3-4 paragraph (400-600 words)';
  } else if (importance >= 40) {
    return '2 paragraph (200-300 words)';
  } else {
    return '1 paragraph (100-150 words)';
  }
}

// =============================================================================
// SUMMARY GENERATION
// =============================================================================

/**
 * Call Anthropic API to generate summary
 */
async function generateSummary(prompt) {
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

  const text = response.content[0].text;
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  // Parse JSON response
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return { ...parsed, tokensUsed };
  } catch (err) {
    console.error(`${colors.yellow}Warning: Could not parse response as JSON${colors.reset}`);
    if (VERBOSE) {
      console.error('Response:', text);
    }
    // Return a basic structure
    return {
      oneLiner: text.slice(0, 200),
      summary: text,
      keyPoints: [],
      keyClaims: [],
      tokensUsed
    };
  }
}

/**
 * Summarize an article
 */
async function summarizeArticle(article) {
  // Truncate content if too long (roughly 100K chars = ~25K tokens)
  const maxContentLength = 100000;
  const content = article.content.length > maxContentLength
    ? article.content.slice(0, maxContentLength) + '\n\n[Content truncated...]'
    : article.content;

  const prompt = ARTICLE_SUMMARY_PROMPT
    .replace('{{TITLE}}', article.title || article.id)
    .replace('{{CONTENT}}', content);

  const result = await generateSummary(prompt);

  summaries.upsert(article.id, 'article', {
    ...result,
    model: MODEL_ID
  });

  return result;
}

/**
 * Summarize a source
 */
async function summarizeSource(source) {
  if (!source.content) {
    throw new Error('Source has no content');
  }

  // Truncate content if too long
  const maxContentLength = 50000;
  const content = source.content.length > maxContentLength
    ? source.content.slice(0, maxContentLength) + '\n\n[Content truncated...]'
    : source.content;

  // Get review length based on importance (default to medium if not set)
  const importance = source.importance || 50;
  const reviewLength = getReviewLengthInstruction(importance);

  const prompt = SOURCE_SUMMARY_PROMPT
    .replace('{{TITLE}}', source.title || 'Unknown')
    .replace('{{TYPE}}', source.source_type || 'unknown')
    .replace('{{AUTHORS}}', Array.isArray(source.authors) ? source.authors.join(', ') : (source.authors || 'Unknown'))
    .replace('{{YEAR}}', source.year || 'Unknown')
    .replace('{{REVIEW_LENGTH}}', reviewLength)
    .replace('{{CONTENT}}', content);

  const result = await generateSummary(prompt);

  summaries.upsert(source.id, 'source', {
    ...result,
    model: MODEL_ID
  });

  return result;
}

// =============================================================================
// PARALLEL PROCESSING
// =============================================================================

/**
 * Process items in parallel batches with rate limiting
 */
async function processInParallel(items, processor, concurrency, onProgress) {
  const results = [];
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
        return { status: 'fulfilled', item, result };
      } catch (err) {
        failed++;
        onProgress?.(globalIndex, item, null, err);
        return { status: 'rejected', item, error: err };
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

async function main() {
  console.log(`${colors.blue}📝 Summary Generator${colors.reset}`);
  console.log(`   Model: ${MODEL_NAME} (${MODEL_ID})`);
  console.log(`   Type: ${TYPE}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  if (DRY_RUN) console.log(`   ${colors.yellow}DRY RUN - no API calls${colors.reset}`);
  console.log();

  let items = [];

  if (SPECIFIC_ID) {
    // Get specific item
    if (TYPE === 'articles') {
      const article = articles.get(SPECIFIC_ID);
      if (!article) {
        console.error(`${colors.red}Article not found: ${SPECIFIC_ID}${colors.reset}`);
        process.exit(1);
      }
      items = [article];
    } else {
      const source = sources.get(SPECIFIC_ID);
      if (!source) {
        console.error(`${colors.red}Source not found: ${SPECIFIC_ID}${colors.reset}`);
        process.exit(1);
      }
      items = [source];
    }
  } else if (TYPE === 'articles') {
    // Get articles needing summaries
    items = RESUMMARY
      ? articles.needingResummary().slice(0, BATCH_SIZE)
      : articles.needingSummary().slice(0, BATCH_SIZE);
  } else if (TYPE === 'sources') {
    // Get sources needing summaries
    items = sources.needingSummary().slice(0, BATCH_SIZE);
  } else {
    console.error(`${colors.red}Unknown type: ${TYPE}. Use 'articles' or 'sources'${colors.reset}`);
    process.exit(1);
  }

  if (items.length === 0) {
    console.log(`${colors.green}✅ No ${TYPE} need summarization${colors.reset}`);
    process.exit(0);
  }

  console.log(`Found ${items.length} ${TYPE} to summarize\n`);

  if (DRY_RUN) {
    console.log('Would summarize:');
    for (const item of items) {
      console.log(`  - ${item.title || item.id}`);
    }
    process.exit(0);
  }

  // Progress callback
  const onProgress = (index, item, result, error) => {
    const progress = `[${index + 1}/${items.length}]`;
    if (error) {
      console.log(`${colors.cyan}${progress}${colors.reset} ${item.title || item.id}`);
      console.log(`   ${colors.red}✗ Error: ${error.message}${colors.reset}`);
    } else {
      console.log(`${colors.cyan}${progress}${colors.reset} ${item.title || item.id}`);
      if (VERBOSE && result) {
        console.log(`   ${colors.dim}One-liner: ${result.oneLiner}${colors.reset}`);
        console.log(`   ${colors.dim}Tokens: ${result.tokensUsed}${colors.reset}`);
      }
      console.log(`   ${colors.green}✓ Done${colors.reset}`);
    }
  };

  // Process items in parallel
  const processor = TYPE === 'articles' ? summarizeArticle : summarizeSource;
  const { completed, failed, totalTokens } = await processInParallel(
    items,
    processor,
    CONCURRENCY,
    onProgress
  );

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${colors.green}✅ Summary generation complete${colors.reset}\n`);
  console.log(`  Successful: ${completed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total tokens used: ${totalTokens.toLocaleString()}`);

  // Estimate cost
  const inputCost = MODEL_NAME === 'haiku' ? 0.00025 : MODEL_NAME === 'sonnet' ? 0.003 : 0.015;
  const estimatedCost = (totalTokens / 1000000) * (inputCost + inputCost * 4); // Rough estimate
  console.log(`  Estimated cost: $${estimatedCost.toFixed(4)}`);

  // Show remaining
  const remainingArticles = articles.needingSummary().length;
  const remainingSources = sources.needingSummary().length;
  console.log(`\n${colors.blue}Remaining:${colors.reset}`);
  console.log(`  Articles without summaries: ${remainingArticles}`);
  console.log(`  Sources without summaries: ${remainingSources}`);
}

main().catch(err => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
