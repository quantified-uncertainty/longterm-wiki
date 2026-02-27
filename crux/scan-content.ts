#!/usr/bin/env node

/**
 * Content Scanning Script
 *
 * Scans all MDX files and populates the knowledge database with:
 * - Article content and metadata
 * - Source references (URLs, DOIs)
 *
 * Usage:
 *   node crux/scan-content.ts [options]
 *
 * Options:
 *   --force       Rescan all files even if unchanged
 *   --stats       Show database statistics only
 *   --verbose     Show detailed progress
 */

import { readFileSync } from 'fs';
import { basename, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  articles,
  sources,
  contentHash,
  hashId,
  getStats,
} from './lib/knowledge-db.ts';
import { findMdxFiles } from './lib/file-utils.ts';
import { parseFrontmatter, getContentBody } from './lib/mdx-utils.ts';
import { getColors } from './lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR, DATA_DIR_ABS as DATA_DIR } from './lib/content-types.ts';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const STATS_ONLY = args.includes('--stats');
const VERBOSE = args.includes('--verbose');

const colors = getColors();

interface Frontmatter {
  title?: string;
  description?: string;
  quality?: number;
  ratings?: { completeness?: number };
  sources?: Array<{
    url?: string;
    title?: string;
    author?: string;
    date?: string;
  }>;
}

interface SourceRef {
  url?: string;
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  sourceType: string;
}

interface ProcessFileResult {
  entityId: string;
  title?: string;
  wordCount?: number;
  sourcesFound?: number;
  skipped: boolean;
}

// =============================================================================
// MDX PROCESSING
// =============================================================================

/**
 * Extract entity ID from file path
 */
function getEntityIdFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.(mdx|md)$/, '');
  // index files use parent directory name
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
    // Remove import statements
    .replace(/^import\s+.*$/gm, '')
    // Remove JSX components (both self-closing and with children)
    .replace(/<[A-Z][a-zA-Z]*\s*[^>]*\/>/g, '')
    .replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove MDX expressions
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    // Clean up excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract URLs and DOIs from content
 */
function extractSourceReferences(content: string, frontmatter: Frontmatter): SourceRef[] {
  const refs: SourceRef[] = [];

  // Extract from frontmatter sources array (if exists)
  if (frontmatter.sources && Array.isArray(frontmatter.sources)) {
    for (const source of frontmatter.sources) {
      if (source.url) {
        refs.push({
          url: source.url,
          title: source.title,
          authors: source.author ? [source.author] : [],
          year: source.date ? parseInt(source.date) : null,
          sourceType: inferSourceType(source.url)
        });
      }
    }
  }

  // Extract URLs from markdown links
  const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = urlRegex.exec(content)) !== null) {
    const [, linkText, url] = match;
    // Skip internal links and common non-source URLs
    if (url.includes('localhost') ||
        url.includes('github.com/anthropics') ||
        url.includes('claude.ai')) {
      continue;
    }
    refs.push({
      url,
      title: linkText,
      sourceType: inferSourceType(url)
    });
  }

  // Extract DOIs
  const doiRegex = /\b(10\.\d{4,}\/[^\s]+)/g;
  while ((match = doiRegex.exec(content)) !== null) {
    refs.push({
      doi: match[1],
      sourceType: 'paper'
    });
  }

  // Deduplicate by URL/DOI
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = ref.url || ref.doi;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Infer source type from URL
 */
function inferSourceType(url: string | undefined): string {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();

  if (lower.includes('arxiv.org')) return 'paper';
  if (lower.includes('doi.org')) return 'paper';
  if (lower.includes('papers.ssrn.com')) return 'paper';
  if (lower.includes('nature.com')) return 'paper';
  if (lower.includes('science.org')) return 'paper';
  if (lower.includes('openai.com/research')) return 'paper';
  if (lower.includes('anthropic.com/research')) return 'paper';
  if (lower.includes('deepmind.com/research')) return 'paper';

  if (lower.includes('lesswrong.com')) return 'blog';
  if (lower.includes('alignmentforum.org')) return 'blog';
  if (lower.includes('substack.com')) return 'blog';
  if (lower.includes('medium.com')) return 'blog';

  if (lower.includes('.gov')) return 'government';
  if (lower.includes('congress.gov')) return 'government';
  if (lower.includes('whitehouse.gov')) return 'government';

  if (lower.includes('wikipedia.org')) return 'reference';
  if (lower.includes('grokipedia.com')) return 'reference';

  if (lower.includes('.pdf')) return 'report';

  return 'web';
}

/**
 * Process a single MDX file
 */
function processFile(filePath: string): ProcessFileResult {
  const raw = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(raw) as Frontmatter;
  const content = getContentBody(raw);

  const entityId = getEntityIdFromPath(filePath);
  const relativePath = relative(PROJECT_ROOT, filePath);
  const text = extractTextContent(content);
  const hash = contentHash(text);

  // Check if we need to process (skip if unchanged and not forcing)
  if (!FORCE && !articles.hasChanged(entityId, hash)) {
    return { entityId, skipped: true };
  }

  // Extract source references
  const sourceRefs = extractSourceReferences(content, frontmatter);

  // Upsert article
  articles.upsert({
    id: entityId,
    path: relativePath,
    title: frontmatter.title || entityId,
    description: frontmatter.description || '',
    content: text,
    wordCount: text.split(/\s+/).length,
    quality: frontmatter.quality || frontmatter.ratings?.completeness || null,
    contentHash: hash
  });

  // Process source references
  for (const ref of sourceRefs) {
    const sourceId = hashId(ref.url || ref.doi || ref.title || '');
    sources.upsert({
      id: sourceId,
      ...ref
    });
    sources.linkToArticle(entityId, sourceId);
  }

  return {
    entityId,
    title: frontmatter.title,
    wordCount: text.split(/\s+/).length,
    sourcesFound: sourceRefs.length,
    skipped: false
  };
}

// =============================================================================
// MAIN
// =============================================================================

function main(): void {
  console.log(`${colors.blue}📚 Content Scanner${colors.reset}\n`);

  if (STATS_ONLY) {
    const stats = getStats();
    console.log('Database Statistics:');
    console.log(`  Articles: ${stats.articles}`);
    console.log(`  Sources: ${JSON.stringify(stats.sources)}`);
    process.exit(0);
  }

  // Find all MDX files
  const mdxFiles = findMdxFiles(CONTENT_DIR);
  console.log(`Found ${mdxFiles.length} content files\n`);

  // Process each file
  let processed = 0;
  let skipped = 0;
  let totalSources = 0;
  let totalWords = 0;

  for (const filePath of mdxFiles) {
    try {
      const result = processFile(filePath);

      if (result.skipped) {
        skipped++;
        if (VERBOSE) {
          console.log(`${colors.dim}⊘ ${result.entityId} (unchanged)${colors.reset}`);
        }
      } else {
        processed++;
        totalSources += result.sourcesFound || 0;
        totalWords += result.wordCount || 0;
        if (VERBOSE) {
          console.log(`${colors.green}✓${colors.reset} ${result.entityId} (${result.wordCount} words, ${result.sourcesFound} sources)`);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(`${colors.red}✗ Error processing ${filePath}: ${error.message}${colors.reset}`);
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${colors.green}✅ Scan complete${colors.reset}\n`);
  console.log(`  Files processed: ${processed}`);
  console.log(`  Files skipped (unchanged): ${skipped}`);
  console.log(`  Total words: ${totalWords.toLocaleString()}`);
  console.log(`  Source references found: ${totalSources}`);

  // Show current stats
  const stats = getStats();
  console.log(`\n${colors.blue}Database totals:${colors.reset}`);
  console.log(`  Articles: ${stats.articles}`);
  console.log(`  Sources: ${stats.sources.total} (${stats.sources.fetched} fetched, ${stats.sources.pending} pending)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
