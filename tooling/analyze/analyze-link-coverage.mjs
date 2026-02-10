#!/usr/bin/env node

/**
 * Link Coverage Analyzer
 *
 * Analyzes cross-referencing health across the wiki:
 * - Calculates link density per page (outgoing EntityLinks)
 * - Identifies pages with low incoming links (orphans)
 * - Finds pages that could benefit from more cross-references
 * - Generates reports on overall wiki connectivity
 *
 * Usage:
 *   node tooling/analyze/analyze-link-coverage.mjs                    # Full report
 *   node tooling/analyze/analyze-link-coverage.mjs --orphans          # Show poorly-linked pages
 *   node tooling/analyze/analyze-link-coverage.mjs --top-linked       # Show most linked pages
 *   node tooling/analyze/analyze-link-coverage.mjs --json             # JSON output
 *   node tooling/analyze/analyze-link-coverage.mjs --page scheming    # Analyze specific page
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.mjs';
import { getColors } from '../lib/output.mjs';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR, GENERATED_DATA_DIR_ABS as DATA_DIR } from '../lib/content-types.mjs';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const SHOW_ORPHANS = args.includes('--orphans');
const SHOW_TOP_LINKED = args.includes('--top-linked');
const colors = getColors(JSON_MODE);

// Find --page argument
const pageArgIndex = args.indexOf('--page');
const SPECIFIC_PAGE = pageArgIndex !== -1 ? args[pageArgIndex + 1] : null;

/**
 * Load backlinks data
 */
function loadBacklinks() {
  const backlinksPath = join(DATA_DIR, 'backlinks.json');
  if (!existsSync(backlinksPath)) {
    console.warn('Warning: backlinks.json not found. Run pnpm build first.');
    return {};
  }
  return JSON.parse(readFileSync(backlinksPath, 'utf-8'));
}

/**
 * Load path registry
 */
function loadPathRegistry() {
  const registryPath = join(DATA_DIR, 'pathRegistry.json');
  if (!existsSync(registryPath)) {
    console.warn('Warning: pathRegistry.json not found. Run pnpm build first.');
    return {};
  }
  return JSON.parse(readFileSync(registryPath, 'utf-8'));
}

/**
 * Count EntityLink components in content
 */
function countEntityLinks(content) {
  const regex = /<EntityLink\s+id="([^"]+)"/g;
  const links = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return links;
}

/**
 * Count markdown links (internal only)
 */
function countMarkdownLinks(content) {
  const regex = /\[([^\]]*)\]\(\/([^)]+)\)/g;
  const links = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[2]);
  }
  return links;
}

/**
 * Extract page slug from file path
 */
function getPageSlug(filePath) {
  const rel = relative(CONTENT_DIR, filePath);
  return rel
    .replace(/\.mdx?$/, '')
    .replace(/\/index$/, '')
    .split('/')
    .pop();
}

/**
 * Analyze a single page
 */
function analyzePage(filePath, backlinks, pathRegistry) {
  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const body = getContentBody(content);
  const relPath = relative(CONTENT_DIR, filePath);
  const slug = getPageSlug(filePath);

  // Count outgoing links
  const entityLinks = countEntityLinks(body);
  const markdownLinks = countMarkdownLinks(body);

  // Get incoming links from backlinks
  const incomingLinks = backlinks[slug] || [];

  // Calculate metrics
  const wordCount = body.split(/\s+/).filter((w) => w.length > 0).length;
  const linkDensity = wordCount > 0 ? (entityLinks.length / wordCount) * 1000 : 0; // Links per 1000 words

  return {
    path: relPath,
    slug,
    title: frontmatter.title || slug,
    importance: frontmatter.importance || 0,
    quality: frontmatter.quality || 0,
    pageType: frontmatter.pageType || 'content',
    wordCount,
    outgoingEntityLinks: entityLinks.length,
    outgoingMarkdownLinks: markdownLinks.length,
    totalOutgoing: entityLinks.length + markdownLinks.length,
    incomingLinks: incomingLinks.length,
    incomingFrom: incomingLinks,
    linkDensity: linkDensity.toFixed(2),
    entityLinkTargets: [...new Set(entityLinks)],
  };
}

/**
 * Generate summary statistics
 */
function generateSummary(pages) {
  const contentPages = pages.filter(
    (p) => p.pageType === 'content' && !p.path.includes('/internal/')
  );

  const totalOutgoing = contentPages.reduce((sum, p) => sum + p.outgoingEntityLinks, 0);
  const totalIncoming = contentPages.reduce((sum, p) => sum + p.incomingLinks, 0);
  const avgOutgoing = contentPages.length > 0 ? totalOutgoing / contentPages.length : 0;
  const avgIncoming = contentPages.length > 0 ? totalIncoming / contentPages.length : 0;

  // Find orphans (pages with 0-1 incoming links, excluding index pages)
  const orphans = contentPages.filter(
    (p) => p.incomingLinks <= 1 && !p.path.includes('index.mdx') && p.importance >= 30
  );

  // Find pages with low outgoing links but high word count
  const underlinkd = contentPages.filter(
    (p) =>
      p.outgoingEntityLinks < 3 && p.wordCount > 500 && p.importance >= 30 && parseFloat(p.linkDensity) < 2
  );

  // Most linked pages
  const topLinked = [...contentPages].sort((a, b) => b.incomingLinks - a.incomingLinks).slice(0, 20);

  // Least linked important pages
  const leastLinked = [...contentPages]
    .filter((p) => p.importance >= 50)
    .sort((a, b) => a.incomingLinks - b.incomingLinks)
    .slice(0, 20);

  return {
    totalPages: contentPages.length,
    totalEntityLinks: totalOutgoing,
    avgOutgoingLinks: avgOutgoing.toFixed(1),
    avgIncomingLinks: avgIncoming.toFixed(1),
    orphanCount: orphans.length,
    underlinkedCount: underlinkd.length,
    orphans,
    underlinked: underlinkd,
    topLinked,
    leastLinked,
  };
}

function main() {
  const backlinks = loadBacklinks();
  const pathRegistry = loadPathRegistry();
  const files = findMdxFiles(CONTENT_DIR);

  // Analyze all pages
  const pages = [];
  for (const file of files) {
    try {
      const analysis = analyzePage(file, backlinks, pathRegistry);
      pages.push(analysis);
    } catch (err) {
      // Skip files that can't be analyzed
    }
  }

  // Handle specific page query
  if (SPECIFIC_PAGE) {
    const page = pages.find(
      (p) => p.slug === SPECIFIC_PAGE || p.path.includes(SPECIFIC_PAGE) || p.title.toLowerCase().includes(SPECIFIC_PAGE.toLowerCase())
    );

    if (!page) {
      console.error(`Page not found: ${SPECIFIC_PAGE}`);
      process.exit(1);
    }

    if (JSON_MODE) {
      console.log(JSON.stringify(page, null, 2));
    } else {
      console.log(`${colors.bold}${colors.cyan}${page.title}${colors.reset}`);
      console.log(`Path: ${page.path}`);
      console.log(`Importance: ${page.importance}, Quality: ${page.quality}`);
      console.log();
      console.log(`${colors.bold}Outgoing Links:${colors.reset}`);
      console.log(`  EntityLinks: ${page.outgoingEntityLinks}`);
      console.log(`  Markdown Links: ${page.outgoingMarkdownLinks}`);
      console.log(`  Link Density: ${page.linkDensity} links/1000 words`);
      console.log();
      console.log(`${colors.bold}Incoming Links:${colors.reset} ${page.incomingLinks}`);
      if (page.incomingFrom.length > 0) {
        // Handle both string and object formats from backlinks.json
        const fromLabels = page.incomingFrom.map(item =>
          typeof item === 'string' ? item : (item.title || item.id || 'unknown')
        );
        console.log(`  From: ${fromLabels.slice(0, 10).join(', ')}${fromLabels.length > 10 ? '...' : ''}`);
      }
      console.log();
      console.log(`${colors.bold}Links To:${colors.reset}`);
      for (const target of page.entityLinkTargets.slice(0, 15)) {
        console.log(`  - ${target}`);
      }
      if (page.entityLinkTargets.length > 15) {
        console.log(`  ... and ${page.entityLinkTargets.length - 15} more`);
      }
    }
    return;
  }

  const summary = generateSummary(pages);

  if (JSON_MODE) {
    console.log(JSON.stringify({ summary, pages }, null, 2));
    return;
  }

  // Print report
  console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}  Link Coverage Report${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  console.log(`${colors.bold}Overview${colors.reset}`);
  console.log(`  Total content pages: ${summary.totalPages}`);
  console.log(`  Total EntityLinks: ${summary.totalEntityLinks}`);
  console.log(`  Avg outgoing links/page: ${summary.avgOutgoingLinks}`);
  console.log(`  Avg incoming links/page: ${summary.avgIncomingLinks}`);
  console.log();

  // Orphan pages
  if (SHOW_ORPHANS || !SHOW_TOP_LINKED) {
    console.log(`${colors.bold}${colors.yellow}Orphan Pages${colors.reset} (≤1 incoming link, importance ≥30): ${summary.orphanCount}`);
    if (summary.orphans.length > 0) {
      const sortedOrphans = summary.orphans.sort((a, b) => b.importance - a.importance);
      for (const page of sortedOrphans.slice(0, 15)) {
        console.log(
          `  ${colors.dim}[imp:${page.importance}]${colors.reset} ${page.title} (${page.incomingLinks} incoming)`
        );
      }
      if (sortedOrphans.length > 15) {
        console.log(`  ${colors.dim}... and ${sortedOrphans.length - 15} more${colors.reset}`);
      }
    }
    console.log();

    console.log(
      `${colors.bold}${colors.yellow}Underlinked Pages${colors.reset} (<3 outgoing, >500 words, importance ≥30): ${summary.underlinkedCount}`
    );
    if (summary.underlinked.length > 0) {
      const sortedUnderlinked = summary.underlinked.sort((a, b) => b.importance - a.importance);
      for (const page of sortedUnderlinked.slice(0, 15)) {
        console.log(
          `  ${colors.dim}[imp:${page.importance}]${colors.reset} ${page.title} (${page.outgoingEntityLinks} EntityLinks, ${page.wordCount} words)`
        );
      }
      if (sortedUnderlinked.length > 15) {
        console.log(`  ${colors.dim}... and ${sortedUnderlinked.length - 15} more${colors.reset}`);
      }
    }
    console.log();
  }

  // Top linked pages
  if (SHOW_TOP_LINKED || !SHOW_ORPHANS) {
    console.log(`${colors.bold}${colors.green}Most Linked Pages${colors.reset} (by incoming links):`);
    for (const page of summary.topLinked.slice(0, 15)) {
      console.log(`  ${page.incomingLinks} ← ${page.title}`);
    }
    console.log();
  }

  // Least linked important pages
  if (!SHOW_TOP_LINKED) {
    console.log(`${colors.bold}${colors.red}Least Linked Important Pages${colors.reset} (importance ≥50):`);
    for (const page of summary.leastLinked.slice(0, 10)) {
      console.log(
        `  ${colors.dim}[imp:${page.importance}]${colors.reset} ${page.incomingLinks} ← ${page.title}`
      );
    }
    console.log();
  }

  // Recommendations
  console.log(`${colors.bold}Recommendations:${colors.reset}`);
  if (summary.orphanCount > 10) {
    console.log(
      `  ${colors.yellow}•${colors.reset} ${summary.orphanCount} orphan pages need incoming links`
    );
  }
  if (summary.underlinkedCount > 10) {
    console.log(
      `  ${colors.yellow}•${colors.reset} ${summary.underlinkedCount} pages could use more cross-references`
    );
  }
  if (parseFloat(summary.avgOutgoingLinks) < 5) {
    console.log(`  ${colors.yellow}•${colors.reset} Average link density is low (${summary.avgOutgoingLinks}/page)`);
  }
  console.log();
  console.log(`${colors.dim}Run with --page <slug> to analyze a specific page${colors.reset}`);
  console.log(`${colors.dim}Run node tooling/crux.mjs analyze mentions to find unlinked entity mentions${colors.reset}`);
}

main();
