#!/usr/bin/env node
/**
 * Quality Discrepancy Validator
 *
 * Finds pages where claimed quality rating doesn't match structural metrics.
 * Helps ensure quality ratings accurately reflect content structure.
 *
 * Quality scale: 0-100 (80+ comprehensive, 60-79 good, 40-59 adequate, 20-39 draft, <20 stub)
 *
 * Usage:
 *   npx tsx crux/validate/validate-quality.ts              # Show all discrepancies
 *   npx tsx crux/validate/validate-quality.ts --large     # Only large discrepancies (>=20 pts)
 *   npx tsx crux/validate/validate-quality.ts --page X    # Check specific page
 *   npx tsx crux/validate/validate-quality.ts --ci        # JSON output for CI
 *
 * Exit codes:
 *   0 = No large discrepancies found
 *   1 = Large discrepancies found (quality claimed >= 20 points higher than structure suggests)
 */

import { fileURLToPath } from 'url';
import { loadPages as loadPagesData } from '../lib/content-types.ts';
import type { PageEntry } from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors as getSharedColors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiscrepancyLevel = 'overrated' | 'slight-over' | 'ok' | 'slight-under' | 'underrated';

interface PageMetrics {
  wordCount: number;
  tableCount: number;
  diagramCount: number;
  internalLinks: number;
  externalLinks: number;
  bulletRatio: number;
  sectionCount: number;
  hasOverview: boolean;
  structuralScore: number;
}

interface PageWithDiscrepancy extends PageEntry {
  discrepancy: number;
  level: DiscrepancyLevel;
}

interface AnsiColors {
  reset: string;
  bold: string;
  dim: string;
  red: string;
  yellow: string;
  green: string;
  blue: string;
  cyan: string;
}

interface QualityValidatorOptions extends ValidatorOptions {
  ci?: boolean;
  large?: boolean;
  page?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeColors(ciMode: boolean): AnsiColors {
  const shared = getSharedColors(ciMode);
  return {
    reset: shared.reset, bold: shared.bold, dim: shared.dim,
    red: shared.red, yellow: shared.yellow, green: shared.green,
    blue: shared.blue, cyan: shared.cyan
  };
}

function loadPages(): PageEntry[] {
  const pages: PageEntry[] = loadPagesData();
  if (pages.length === 0) {
    console.error('Error: pages.json is empty after auto-build. Check data/ directory for issues.');
    process.exit(1);
  }
  return pages;
}

function getDiscrepancyLevel(quality: number, suggested: number): DiscrepancyLevel {
  const diff: number = quality - suggested;
  // 0-100 scale: 20+ points is a major discrepancy (one full tier)
  if (diff >= 20) return 'overrated';      // Claimed much higher than structure
  if (diff >= 10) return 'slight-over';    // Slightly overrated
  if (Math.abs(diff) < 10) return 'ok';    // Within acceptable range
  if (diff >= -20) return 'slight-under';  // Slightly underrated
  return 'underrated';                      // Could be rated higher
}

function formatMetrics(metrics: PageMetrics | undefined): string {
  if (!metrics) return 'No metrics';

  const parts: string[] = [];
  parts.push(`📊 ${metrics.tableCount} tables`);
  parts.push(`📈 ${metrics.diagramCount} diagrams`);
  parts.push(`🔗 ${metrics.internalLinks} internal`);
  parts.push(`📚 ${metrics.externalLinks} external`);
  parts.push(`• ${Math.round(metrics.bulletRatio * 100)}% bullets`);
  parts.push(`📝 ${metrics.wordCount} words`);

  return parts.join(' | ');
}

function getImprovementSuggestions(
  metrics: PageMetrics | undefined,
  currentQuality: number,
  targetQuality: number,
): string[] {
  if (!metrics) return [];

  const suggestions: string[] = [];
  const neededPoints: number = (targetQuality - 1) * 3; // Rough mapping

  // Tables (0-3 pts)
  if (metrics.tableCount < 2) {
    suggestions.push(`Add ${2 - metrics.tableCount} more table(s) - currently ${metrics.tableCount}`);
  }

  // Diagrams (0-2 pts)
  if (metrics.diagramCount < 1) {
    suggestions.push('Add a Mermaid diagram showing key relationships');
  }

  // External citations (0-3 pts)
  if (metrics.externalLinks < 6) {
    suggestions.push(`Add ${6 - metrics.externalLinks} more external citations - currently ${metrics.externalLinks}`);
  }

  // Internal links (0-2 pts)
  if (metrics.internalLinks < 4) {
    suggestions.push(`Add ${4 - metrics.internalLinks} more internal cross-links - currently ${metrics.internalLinks}`);
  }

  // Bullet ratio (0-2 pts)
  if (metrics.bulletRatio >= 0.5) {
    suggestions.push(`Reduce bullet ratio from ${Math.round(metrics.bulletRatio * 100)}% to under 30% (convert to prose)`);
  }

  // Overview section
  if (!metrics.hasOverview) {
    suggestions.push('Add an "## Overview" section');
  }

  return suggestions;
}

/**
 * Run the quality discrepancy check.
 * Returns a ValidatorResult for use by the orchestrator.
 */
export function runCheck(options?: QualityValidatorOptions): ValidatorResult {
  const CI_MODE = options?.ci ?? false;
  const LARGE_ONLY = options?.large ?? false;
  const PAGE_FILTER: string | null = options?.page ?? null;
  const colors: AnsiColors = makeColors(CI_MODE);

  const pages: PageEntry[] = loadPages();

  // Filter and analyze
  let candidates: PageEntry[] = pages.filter((p: PageEntry) =>
    p.quality !== null &&
    p.suggestedQuality !== null
  );

  if (PAGE_FILTER) {
    candidates = candidates.filter((p: PageEntry) =>
      p.id.includes(PAGE_FILTER) ||
      p.path.includes(PAGE_FILTER) ||
      p.title.toLowerCase().includes(PAGE_FILTER.toLowerCase())
    );
  }

  // Categorize by discrepancy
  const overrated: PageWithDiscrepancy[] = [];
  const slightOver: PageWithDiscrepancy[] = [];
  const ok: PageWithDiscrepancy[] = [];
  const slightUnder: PageWithDiscrepancy[] = [];
  const underrated: PageWithDiscrepancy[] = [];

  for (const page of candidates) {
    const level: DiscrepancyLevel = getDiscrepancyLevel(page.quality!, page.suggestedQuality!);
    const entry: PageWithDiscrepancy = {
      ...page,
      discrepancy: page.quality! - page.suggestedQuality!,
      level,
    };

    if (level === 'overrated') overrated.push(entry);
    else if (level === 'slight-over') slightOver.push(entry);
    else if (level === 'ok') ok.push(entry);
    else if (level === 'slight-under') slightUnder.push(entry);
    else underrated.push(entry);
  }

  // Sort by discrepancy magnitude
  overrated.sort((a: PageWithDiscrepancy, b: PageWithDiscrepancy) => b.discrepancy - a.discrepancy);
  slightOver.sort((a: PageWithDiscrepancy, b: PageWithDiscrepancy) => b.discrepancy - a.discrepancy);
  underrated.sort((a: PageWithDiscrepancy, b: PageWithDiscrepancy) => a.discrepancy - b.discrepancy);
  slightUnder.sort((a: PageWithDiscrepancy, b: PageWithDiscrepancy) => a.discrepancy - b.discrepancy);

  if (CI_MODE) {
    console.log(JSON.stringify({
      total: candidates.length,
      overrated: overrated.length,
      slightOver: slightOver.length,
      ok: ok.length,
      slightUnder: slightUnder.length,
      underrated: underrated.length,
      issues: [...overrated, ...slightOver],
    }, null, 2));

    return {
      passed: overrated.length === 0,
      errors: overrated.length,
      warnings: slightOver.length,
    };
  }

  // Human-readable output
  console.log(`\n${colors.bold}Quality Discrepancy Report${colors.reset}\n`);
  console.log(`Checked ${candidates.length} pages with quality ratings\n`);

  // Summary bar
  const total: number = candidates.length;
  console.log(`${colors.green}✓ ${ok.length} OK${colors.reset} | ` +
    `${colors.yellow}⚠ ${slightOver.length + slightUnder.length} minor${colors.reset} | ` +
    `${colors.red}✗ ${overrated.length + underrated.length} major${colors.reset}\n`);

  // Show overrated (most important - quality claims not backed by structure)
  if (overrated.length > 0) {
    console.log(`${colors.red}${colors.bold}OVERRATED (quality ${'>'}= suggested + 2)${colors.reset}`);
    console.log(`${colors.dim}These pages claim higher quality than their structure supports:${colors.reset}\n`);

    for (const page of overrated) {
      console.log(`${colors.bold}${page.title}${colors.reset}`);
      console.log(`  Path: ${page.path}`);
      console.log(`  ${colors.red}Quality: ${page.quality}${colors.reset} vs ${colors.green}Suggested: ${page.suggestedQuality}${colors.reset} (structural score: ${page.metrics?.structuralScore}/15)`);
      console.log(`  ${formatMetrics(page.metrics as PageMetrics | undefined)}`);

      const suggestions: string[] = getImprovementSuggestions(page.metrics as PageMetrics | undefined, page.quality!, page.quality!);
      if (suggestions.length > 0) {
        console.log(`  ${colors.cyan}To justify Q${page.quality}:${colors.reset}`);
        suggestions.forEach((s: string) => console.log(`    → ${s}`));
      }
      console.log();
    }
  }

  // Show slight overrates if not filtering
  if (!LARGE_ONLY && slightOver.length > 0) {
    console.log(`${colors.yellow}${colors.bold}SLIGHTLY OVERRATED (quality = suggested + 1)${colors.reset}\n`);

    for (const page of slightOver.slice(0, 10)) {
      console.log(`  ${page.title}: Q${page.quality} vs suggested Q${page.suggestedQuality} (score: ${page.metrics?.structuralScore}/15)`);
    }
    if (slightOver.length > 10) {
      console.log(`  ... and ${slightOver.length - 10} more`);
    }
    console.log();
  }

  // Show underrated (could be upgraded)
  if (!LARGE_ONLY && underrated.length > 0) {
    console.log(`${colors.blue}${colors.bold}UNDERRATED (quality ${`<`}= suggested - 2)${colors.reset}`);
    console.log(`${colors.dim}These pages could have higher quality ratings:${colors.reset}\n`);

    for (const page of underrated.slice(0, 5)) {
      console.log(`  ${page.title}: Q${page.quality} but structure suggests Q${page.suggestedQuality}`);
    }
    if (underrated.length > 5) {
      console.log(`  ... and ${underrated.length - 5} more`);
    }
    console.log();
  }

  // Exit with error if overrated pages exist
  if (overrated.length > 0) {
    console.log(`${colors.red}Found ${overrated.length} significantly overrated page(s).${colors.reset}\n`);

    // Show easy re-grade commands
    console.log(`${colors.bold}To re-grade these pages:${colors.reset}`);
    console.log(`${colors.dim}(requires ANTHROPIC_API_KEY in .env or environment)${colors.reset}\n`);

    // Single page commands
    console.log(`${colors.cyan}Re-grade one page:${colors.reset}`);
    const firstPage: PageWithDiscrepancy = overrated[0];
    console.log(`  npm run regrade -- ${firstPage.id}\n`);

    // Batch command for all overrated
    if (overrated.length > 1) {
      console.log(`${colors.cyan}Re-grade all ${overrated.length} overrated pages:${colors.reset}`);
      const ids: string = overrated.map((p: PageWithDiscrepancy) => p.id).join(' ');
      console.log(`  npm run regrade -- ${ids}\n`);
    }

    // Or manual fix for stubs
    const stubs: PageWithDiscrepancy[] = overrated.filter((p: PageWithDiscrepancy) => p.path.includes('stub') || (p.metrics?.wordCount || 0) < 200);
    if (stubs.length > 0) {
      console.log(`${colors.cyan}Or manually lower quality for stub/short pages:${colors.reset}`);
      stubs.forEach((p: PageWithDiscrepancy) => {
        console.log(`  ${p.id}: quality ${p.quality} → ~${Math.min(35, p.suggestedQuality!)}`);
      });
      console.log();
    }
  } else {
    console.log(`${colors.green}No significantly overrated pages found.${colors.reset}\n`);
  }

  return {
    passed: overrated.length === 0,
    errors: overrated.length,
    warnings: slightOver.length,
  };
}

function main(): void {
  const parsed = parseCliArgs(process.argv.slice(2));

  const result = runCheck({
    ci: parsed.ci === true,
    large: parsed.large === true,
    page: (parsed.page as string) || null,
  });

  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
