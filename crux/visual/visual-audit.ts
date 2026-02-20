#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Visual Audit Pipeline
 *
 * Scans the wiki to identify pages that would benefit from visual elements.
 * Reports visual coverage, gaps, and suggests which visual types to add.
 *
 * Usage:
 *   crux visual audit                          # Default: pages with 500+ words
 *   crux visual audit --min-words=800           # Only check longer pages
 *   crux visual audit --format=json             # JSON output
 *   crux visual audit --verbose                 # Include AI suggestions
 */

import fs from 'fs';
import path from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, isCI } from '../lib/output.ts';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.ts';
import {
  type GeneratableVisualType,
  type PageVisualCoverage,
  countVisuals,
} from './visual-types.ts';

// ============================================================================
// Content analysis
// ============================================================================

function countWords(content: string): number {
  const body = getContentBody(content);
  const noImports = body.replace(/^import\s+.*$/gm, '');
  const noJsx = noImports.replace(/<[^>]+>/g, ' ');
  const noCode = noJsx.replace(/```[\s\S]*?```/g, '');
  return noCode.split(/\s+/).filter((w) => w.length > 0).length;
}

function suggestVisualTypes(content: string): GeneratableVisualType[] {
  const suggestions: GeneratableVisualType[] = [];
  const body = getContentBody(content).toLowerCase();

  // Mermaid: pages with processes, hierarchies, categorizations
  if (
    /\b(process|pipeline|workflow|stages?|steps?|phases?|hierarchy|taxonomy|categories|classification)\b/.test(
      body,
    )
  ) {
    suggestions.push('mermaid');
  }

  // Squiggle: pages with numbers, estimates, probabilities, costs
  if (
    /\b(estimat|probabilit|likeli|forecast|cost|funding|budget|\$|billion|million|percent|%)\b/.test(
      body,
    )
  ) {
    suggestions.push('squiggle');
  }

  // CauseEffect: pages about risks, causes, effects, influences
  if (
    /\b(caus|effect|influenc|contribut|leads? to|results? in|impact|factor|driver)\b/.test(
      body,
    )
  ) {
    suggestions.push('cause-effect');
  }

  // Comparison: pages comparing approaches, organizations, methods
  if (
    /\b(compar|versus|vs\.?|alternative|approach|method|framework|advantage|disadvantage|tradeoff|trade-off)\b/.test(
      body,
    )
  ) {
    suggestions.push('comparison');
  }

  // Disagreement: pages with debate, controversy, differing views
  if (
    /\b(disagree|debate|controvers|position|perspective|view|argue|critic|proponent|skeptic|optimist|pessimist)\b/.test(
      body,
    )
  ) {
    suggestions.push('disagreement');
  }

  return suggestions;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const colors = getColors();
  const ci = isCI() || !!args.ci;

  const minWords = parseInt((args.minWords || args['min-words']) as string) || 500;
  const format = (args.format as string) || 'table';
  const verbose = !!args.verbose;

  const files = findMdxFiles(CONTENT_DIR_ABS);
  const coverage: PageVisualCoverage[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const wordCount = countWords(content);

    if (wordCount < minWords) continue;

    const slug = path.basename(file, path.extname(file));
    const relPath = path.relative(CONTENT_DIR_ABS, file);
    const frontmatter = parseFrontmatter(content);
    const title = (frontmatter.title as string) || slug;
    const quality = typeof frontmatter.quality === 'number' ? frontmatter.quality : undefined;
    const importance = typeof frontmatter.readerImportance === 'number' ? frontmatter.readerImportance :
                       typeof frontmatter.importance === 'number' ? frontmatter.importance : undefined;

    const visualCounts = countVisuals(content);
    const totalVisuals = visualCounts.total;

    const suggestedTypes = suggestVisualTypes(content);
    // A page needs visuals if it has none and either importance >= 50 or word count >= 800
    const needsVisuals =
      totalVisuals === 0 &&
      (((importance || 0) >= 50) || wordCount >= 800);

    coverage.push({
      pageId: slug,
      pagePath: relPath,
      title,
      wordCount,
      quality,
      importance,
      visuals: visualCounts,
      needsVisuals,
      suggestedTypes,
    });
  }

  // Sort: pages needing visuals first, then by importance descending
  coverage.sort((a, b) => {
    if (a.needsVisuals && !b.needsVisuals) return -1;
    if (!a.needsVisuals && b.needsVisuals) return 1;
    return (b.importance || 0) - (a.importance || 0);
  });

  // Statistics
  const totalPages = coverage.length;
  const pagesWithVisuals = coverage.filter((p) => p.visuals.total > 0).length;
  const pagesNeedingVisuals = coverage.filter((p) => p.needsVisuals).length;
  const totalVisualCount = coverage.reduce((a, p) => a + p.visuals.total, 0);

  const typeCounts = {
    mermaid: coverage.reduce((a, p) => a + p.visuals.mermaid, 0),
    squiggle: coverage.reduce((a, p) => a + p.visuals.squiggle, 0),
    'cause-effect': coverage.reduce((a, p) => a + p.visuals['cause-effect'], 0),
    comparison: coverage.reduce((a, p) => a + p.visuals.comparison, 0),
    disagreement: coverage.reduce((a, p) => a + p.visuals.disagreement, 0),
    'table-view': coverage.reduce((a, p) => a + p.visuals['table-view'], 0),
    'markdown-table': coverage.reduce((a, p) => a + p.visuals['markdown-table'], 0),
  };

  if (format === 'json' || ci) {
    console.log(
      JSON.stringify(
        {
          summary: {
            totalPages,
            pagesWithVisuals,
            pagesNeedingVisuals,
            totalVisualCount,
            typeCounts,
            coveragePercent: Math.round((pagesWithVisuals / totalPages) * 100),
          },
          pages: coverage,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Table format
  console.log(`${colors.bold}Visual Coverage Audit${colors.reset}`);
  console.log(`${colors.dim}Pages with ${minWords}+ words${colors.reset}\n`);

  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  Total pages analyzed:   ${totalPages}`);
  console.log(`  Pages with visuals:     ${pagesWithVisuals} (${Math.round((pagesWithVisuals / totalPages) * 100)}%)`);
  console.log(`  Pages needing visuals:  ${colors.yellow}${pagesNeedingVisuals}${colors.reset}`);
  console.log(`  Total visual elements:  ${totalVisualCount}`);
  console.log();
  console.log(`${colors.bold}By type:${colors.reset}`);
  console.log(`  Mermaid:         ${typeCounts.mermaid}`);
  console.log(`  Squiggle:        ${typeCounts.squiggle}`);
  console.log(`  CauseEffect:     ${typeCounts['cause-effect']}`);
  console.log(`  Comparison:      ${typeCounts.comparison}`);
  console.log(`  Disagreement:    ${typeCounts.disagreement}`);
  console.log(`  TableView:       ${typeCounts['table-view']}`);
  console.log(`  Markdown Table:  ${typeCounts['markdown-table']}`);
  console.log();

  if (pagesNeedingVisuals > 0) {
    console.log(
      `${colors.bold}Pages needing visuals (top 30):${colors.reset}\n`,
    );
    console.log(
      `  ${'Page'.padEnd(40)} ${'Words'.padEnd(7)} ${'Imp'.padEnd(5)} ${'Suggested Types'}`,
    );
    console.log(`  ${'─'.repeat(40)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(30)}`);

    const toShow = coverage
      .filter((p) => p.needsVisuals)
      .slice(0, 30);

    for (const page of toShow) {
      const types = page.suggestedTypes.join(', ') || 'mermaid';
      console.log(
        `  ${page.pageId.padEnd(40)} ${String(page.wordCount).padEnd(7)} ${String(page.importance || '-').padEnd(5)} ${types}`,
      );
    }
    console.log();
  }

  // Pages WITH visuals (for review)
  if (verbose) {
    const withVisuals = coverage.filter((p) => p.visuals.total > 0).slice(0, 20);
    if (withVisuals.length > 0) {
      console.log(
        `${colors.bold}Pages with visuals (top 20):${colors.reset}\n`,
      );
      console.log(
        `  ${'Page'.padEnd(40)} ${'M'.padEnd(3)} ${'S'.padEnd(3)} ${'CE'.padEnd(4)} ${'CT'.padEnd(4)} ${'DM'.padEnd(4)} ${'Total'}`,
      );
      console.log(
        `  ${'─'.repeat(40)} ${'─'.repeat(3)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(5)}`,
      );

      for (const page of withVisuals) {
        console.log(
          `  ${page.pageId.padEnd(40)} ${String(page.visuals.mermaid).padEnd(3)} ${String(page.visuals.squiggle).padEnd(3)} ${String(page.visuals['cause-effect']).padEnd(4)} ${String(page.visuals.comparison).padEnd(4)} ${String(page.visuals.disagreement).padEnd(4)} ${page.visuals.total}`,
        );
      }
      console.log();
    }
  }

  console.log(
    `${colors.dim}Run with --verbose to see pages that already have visuals${colors.reset}`,
  );
  console.log(
    `${colors.dim}Run "crux visual create <page-id> --type <type>" to add visuals${colors.reset}`,
  );
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
