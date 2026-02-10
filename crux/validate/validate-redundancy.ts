#!/usr/bin/env node
/**
 * Redundancy Validator
 *
 * Detects duplicate/similar content across knowledge base articles.
 * Uses n-gram shingling to find overlapping paragraphs.
 *
 * Usage:
 *   npx tsx crux/validate/validate-redundancy.ts              # Full report
 *   npx tsx crux/validate/validate-redundancy.ts --top 10    # Top 10 most redundant pairs
 *   npx tsx crux/validate/validate-redundancy.ts --threshold 0.3  # Custom similarity threshold
 */

import { fileURLToPath } from 'url';
import { db, articles } from '../lib/knowledge-db.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

// =============================================================================
// TYPES
// =============================================================================

interface Article {
  id: string;
  path: string;
  title: string;
  content: string;
}

interface ProcessedArticle {
  id: string;
  path: string;
  title: string;
  paragraphs: string[];
  shingles: Set<string>;
  words: Set<string>;
  paragraphShingles: Set<string>[];
}

interface RedundancyPair {
  articleA: ProcessedArticle;
  articleB: ProcessedArticle;
  similarity: number;
  wordSimilarity: number;
  overlappingShingles: number;
  totalShingles: number;
}

interface WordPair {
  articleA: ProcessedArticle;
  articleB: ProcessedArticle;
  similarity: number;
  wordSimilarity: number;
}

interface ParagraphOccurrence {
  articleId: string;
  path: string;
  paragraphIndex: number;
  preview: string;
}

interface RepeatedParagraph {
  preview: string;
  count: number;
  occurrences: ParagraphOccurrence[];
}

interface AnalysisResults {
  pairs: RedundancyPair[];
  wordPairs: WordPair[];
  repeatedParagraphs: RepeatedParagraph[];
  totalArticles: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_THRESHOLD = 0.25;  // Minimum Jaccard similarity to report
const SHINGLE_SIZE = 5;          // Number of words per shingle
const MIN_PARAGRAPH_WORDS = 20;  // Ignore short paragraphs
const MIN_WORD_LENGTH = 5;       // Minimum word length for word-level analysis

// Template headers and phrases that are intentionally consistent across pages
// These should NOT count as duplication since they're part of the page structure
const TEMPLATE_PHRASES: string[] = [
  // Common section headers (normalized - lowercase, no punctuation)
  'quick assessment',
  'organization details',
  'overview',
  'history',
  'key personnel',
  'funding history',
  'strengths and limitations',
  'external links',
  'sources',
  'references',
  'see also',
  'related pages',
  'backlinks',

  // Future projections template headers
  'executive summary',
  'timeline phases',
  'branch points',
  'preconditions',
  'warning signs',
  'valuable actions',
  'probability assessment',
  'who benefits',
  'who loses',

  // Risk page template headers
  'risk assessment',
  'responses that address this risk',
  'why this matters',
  'key uncertainties',
  'how it works',
  'limitations',
  'critical assessment',

  // Common table headers (normalized)
  'dimension',
  'rating',
  'justification',
  'aspect',
  'assessment',
  'severity',
  'likelihood',
  'timeline',
  'trend',
  'tractability',
  'neglectedness',
  'importance',
  'description',

  // Common structural phrases
  'this page is part of',
  'for more information see',
  'related topics include',
  'key takeaways',
  'bottom line',
  'summary',
  'conclusion',

  // Organization page common phrases
  'founded',
  'headquarters',
  'website',
  'leadership',
  'annual budget',
  'funding sources',
  'key programs',
  'notable projects',
  'team size',
  'staff count'
];

// =============================================================================
// TEXT PROCESSING
// =============================================================================

/**
 * Normalize text for comparison
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Remove punctuation
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim();
}

/**
 * Remove template phrases from normalized text
 * This prevents intentionally consistent structure from counting as duplication
 */
function removeTemplatePhrases(normalizedText: string): string {
  let result = normalizedText;

  for (const phrase of TEMPLATE_PHRASES) {
    // Create a regex that matches the phrase as a whole word/phrase
    // (with word boundaries to avoid partial matches)
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, ' ');
  }

  // Collapse any resulting multiple spaces
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Split content into paragraphs
 */
function getParagraphs(content: string): string[] {
  if (!content) return [];

  // Remove MDX imports, frontmatter, code blocks
  const cleaned = content
    .replace(/^---[\s\S]*?---/m, '')           // Frontmatter
    .replace(/^import\s+.*$/gm, '')            // Imports
    .replace(/```[\s\S]*?```/g, '')            // Code blocks
    .replace(/<[^>]+>/g, '')                   // JSX/HTML tags
    .replace(/\|[^\n]+\|/g, '')                // Table rows
    .replace(/#+\s+/g, '')                     // Headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // Links -> text
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // Bold
    .replace(/\*([^*]+)\*/g, '$1');            // Italic

  // Split on double newlines
  return cleaned
    .split(/\n\s*\n/)
    .map((p: string) => normalize(p))
    .map((p: string) => removeTemplatePhrases(p))  // Filter out template phrases
    .filter((p: string) => p.split(/\s+/).length >= MIN_PARAGRAPH_WORDS);
}

/**
 * Generate n-gram shingles from text
 */
function getShingles(text: string, n: number = SHINGLE_SIZE): Set<string> {
  const words = text.split(/\s+/);
  if (words.length < n) return new Set();

  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

/**
 * Get significant words (for conceptual similarity)
 */
function getWords(text: string): Set<string> {
  const words = text.match(/\b\w+\b/g) || [];
  return new Set(words.filter((w: string) => w.length >= MIN_WORD_LENGTH));
}

/**
 * Calculate Jaccard similarity between two sets
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find overlapping shingles between two documents
 */
function findOverlappingShingles(shinglesA: Set<string>, shinglesB: Set<string>): string[] {
  const overlap: string[] = [];
  for (const shingle of shinglesA) {
    if (shinglesB.has(shingle)) {
      overlap.push(shingle);
    }
  }
  return overlap;
}

// =============================================================================
// ANALYSIS
// =============================================================================

/**
 * Analyze all articles for redundancy
 */
function analyzeRedundancy(threshold: number = DEFAULT_THRESHOLD): AnalysisResults {
  // Get all articles
  const allArticles: Article[] = articles.getAll();
  console.log(`\nAnalyzing ${allArticles.length} articles for redundancy...\n`);

  // Process each article
  const processed: ProcessedArticle[] = allArticles.map((article: Article) => {
    const paragraphs = getParagraphs(article.content);
    const allText = paragraphs.join(' ');
    const shingles = getShingles(allText);
    const words = getWords(allText);

    return {
      id: article.id,
      path: article.path,
      title: article.title,
      paragraphs,
      shingles,
      words,
      paragraphShingles: paragraphs.map((p: string) => getShingles(p))
    };
  }).filter((a: ProcessedArticle) => a.shingles.size > 0);

  // Compare all pairs
  const pairs: RedundancyPair[] = [];
  const wordPairs: WordPair[] = [];  // For conceptual similarity
  const WORD_THRESHOLD = 0.25;  // Higher threshold for word overlap

  for (let i = 0; i < processed.length; i++) {
    for (let j = i + 1; j < processed.length; j++) {
      const a = processed[i];
      const b = processed[j];

      const similarity = jaccardSimilarity(a.shingles, b.shingles);
      const wordSimilarity = jaccardSimilarity(a.words, b.words);

      if (similarity >= threshold) {
        const overlapping = findOverlappingShingles(a.shingles, b.shingles);
        pairs.push({
          articleA: a,
          articleB: b,
          similarity,
          wordSimilarity,
          overlappingShingles: overlapping.length,
          totalShingles: a.shingles.size + b.shingles.size - overlapping.length
        });
      }

      // Track high word overlap separately (catches conceptual similarity)
      if (wordSimilarity >= WORD_THRESHOLD && similarity < threshold) {
        wordPairs.push({
          articleA: a,
          articleB: b,
          similarity,
          wordSimilarity
        });
      }
    }
  }

  // Sort by similarity
  pairs.sort((a: RedundancyPair, b: RedundancyPair) => b.similarity - a.similarity);
  wordPairs.sort((a: WordPair, b: WordPair) => b.wordSimilarity - a.wordSimilarity);

  // Find repeated paragraphs across multiple documents
  const paragraphIndex = new Map<string, ParagraphOccurrence[]>(); // shingle hash -> [article, paragraph]
  for (const article of processed) {
    for (let i = 0; i < article.paragraphs.length; i++) {
      const pShingles = article.paragraphShingles[i];
      if (pShingles.size < 5) continue;  // Skip tiny paragraphs

      // Create a rough hash of the paragraph
      const sortedShingles = [...pShingles].sort().slice(0, 10).join('|');

      if (!paragraphIndex.has(sortedShingles)) {
        paragraphIndex.set(sortedShingles, []);
      }
      paragraphIndex.get(sortedShingles)!.push({
        articleId: article.id,
        path: article.path,
        paragraphIndex: i,
        preview: article.paragraphs[i].slice(0, 100)
      });
    }
  }

  // Find paragraphs that appear in multiple articles
  const repeatedParagraphs: RepeatedParagraph[] = [...paragraphIndex.entries()]
    .filter(([_, occurrences]) => occurrences.length > 1)
    .map(([hash, occurrences]) => ({
      preview: occurrences[0].preview,
      count: occurrences.length,
      occurrences
    }))
    .sort((a: RepeatedParagraph, b: RepeatedParagraph) => b.count - a.count);

  return { pairs, wordPairs, repeatedParagraphs, totalArticles: processed.length };
}

// =============================================================================
// REPORTING
// =============================================================================

function formatPath(path: string): string {
  // Shorten path for display
  return path.replace('content/docs/knowledge-base/', '').replace('.mdx', '');
}

function printReport(results: AnalysisResults, topN: number | null = null): number {
  const { pairs, wordPairs, repeatedParagraphs, totalArticles } = results;

  console.log('═'.repeat(70));
  console.log('REDUNDANCY REPORT');
  console.log('═'.repeat(70));
  console.log(`\nAnalyzed: ${totalArticles} articles`);
  console.log(`Found: ${pairs.length} exact-phrase pairs (n-gram overlap)`);
  console.log(`Found: ${wordPairs.length} conceptually similar pairs (word overlap)`);
  console.log(`Found: ${repeatedParagraphs.length} repeated paragraph patterns\n`);

  // High overlap pairs
  console.log('─'.repeat(70));
  console.log('HIGH OVERLAP PAIRS');
  console.log('─'.repeat(70));

  const pairsToShow = topN ? pairs.slice(0, topN) : pairs.slice(0, 20);

  if (pairsToShow.length === 0) {
    console.log('\nNo pairs above threshold found.\n');
  } else {
    for (const pair of pairsToShow) {
      const pct = (pair.similarity * 100).toFixed(1);
      console.log(`\n  ${pct}% similar:`);
      console.log(`    • ${formatPath(pair.articleA.path)}`);
      console.log(`    • ${formatPath(pair.articleB.path)}`);
      console.log(`    (${pair.overlappingShingles} shared shingles)`);
    }
  }

  // Conceptually similar pairs (word overlap)
  if (wordPairs.length > 0) {
    console.log('\n' + '─'.repeat(70));
    console.log('CONCEPTUALLY SIMILAR PAIRS (high word overlap, different phrasing)');
    console.log('─'.repeat(70));

    const wordPairsToShow = topN ? wordPairs.slice(0, topN) : wordPairs.slice(0, 15);

    for (const pair of wordPairsToShow) {
      const pct = (pair.wordSimilarity * 100).toFixed(1);
      console.log(`\n  ${pct}% word overlap:`);
      console.log(`    • ${formatPath(pair.articleA.path)}`);
      console.log(`    • ${formatPath(pair.articleB.path)}`);
    }
  }

  // Repeated paragraphs
  console.log('\n' + '─'.repeat(70));
  console.log('REPEATED PARAGRAPHS (appear in 2+ articles)');
  console.log('─'.repeat(70));

  const paragraphsToShow = repeatedParagraphs.slice(0, 15);

  if (paragraphsToShow.length === 0) {
    console.log('\nNo repeated paragraphs found.\n');
  } else {
    for (const rp of paragraphsToShow) {
      console.log(`\n  Appears in ${rp.count} articles:`);
      console.log(`    "${rp.preview}..."`);
      for (const occ of rp.occurrences.slice(0, 5)) {
        console.log(`      - ${formatPath(occ.path)}`);
      }
      if (rp.occurrences.length > 5) {
        console.log(`      ... and ${rp.occurrences.length - 5} more`);
      }
    }
  }

  // Suggestions
  console.log('\n' + '─'.repeat(70));
  console.log('SUGGESTIONS');
  console.log('─'.repeat(70));

  if (pairs.length > 0) {
    // Find articles that appear in multiple high-similarity pairs
    const articleFrequency = new Map<string, number>();
    for (const pair of pairs) {
      const idA = pair.articleA.id;
      const idB = pair.articleB.id;
      articleFrequency.set(idA, (articleFrequency.get(idA) || 0) + 1);
      articleFrequency.set(idB, (articleFrequency.get(idB) || 0) + 1);
    }

    const frequentArticles = [...articleFrequency.entries()]
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (frequentArticles.length > 0) {
      console.log('\n  Articles with most overlap (consider consolidating or extracting shared content):');
      for (const [id, count] of frequentArticles) {
        const article = pairs.find(p => p.articleA.id === id || p.articleB.id === id);
        const path = article!.articleA.id === id ? article!.articleA.path : article!.articleB.path;
        console.log(`    • ${formatPath(path)} (overlaps with ${count} articles)`);
      }
    }
  }

  if (repeatedParagraphs.length > 0) {
    console.log('\n  Consider moving repeated content to shared pages:');
    const topRepeated = repeatedParagraphs.slice(0, 3);
    for (const rp of topRepeated) {
      const topic = rp.preview.slice(0, 50);
      console.log(`    • "${topic}..." (${rp.count} occurrences)`);
    }
  }

  console.log('\n' + '═'.repeat(70));

  // Return exit code based on findings
  return (pairs.length > 0 || wordPairs.length > 0) ? 1 : 0;
}

// =============================================================================
// RUNCHECK + MAIN
// =============================================================================

/**
 * Run the redundancy check and return a ValidatorResult.
 * Can be called in-process by the orchestrator.
 */
export function runCheck(options: ValidatorOptions = {}): ValidatorResult {
  const threshold = DEFAULT_THRESHOLD;
  const results = analyzeRedundancy(threshold);

  return {
    passed: results.pairs.length === 0 && results.wordPairs.length === 0,
    errors: 0,
    warnings: results.pairs.length + results.wordPairs.length,
    infos: results.repeatedParagraphs.length,
  };
}

function main(): void {
  const args = process.argv.slice(2);

  // Parse arguments
  let threshold = DEFAULT_THRESHOLD;
  let topN: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && args[i + 1]) {
      threshold = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--top' && args[i + 1]) {
      topN = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--help') {
      console.log(`
Usage: npx tsx crux/validate/validate-redundancy.ts [options]

Options:
  --threshold <n>  Minimum Jaccard similarity to report (default: ${DEFAULT_THRESHOLD})
  --top <n>        Only show top N most similar pairs
  --help           Show this help message

Examples:
  npx tsx crux/validate/validate-redundancy.ts                    # Full report
  npx tsx crux/validate/validate-redundancy.ts --top 10          # Top 10 pairs
  npx tsx crux/validate/validate-redundancy.ts --threshold 0.4   # Higher threshold
      `);
      process.exit(0);
    }
  }

  try {
    const results = analyzeRedundancy(threshold);
    const exitCode = printReport(results, topN);
    process.exit(exitCode);
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
