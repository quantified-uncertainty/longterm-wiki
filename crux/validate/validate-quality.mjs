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
 *   node scripts/validate-quality.mjs              # Show all discrepancies
 *   node scripts/validate-quality.mjs --large     # Only large discrepancies (>=20 pts)
 *   node scripts/validate-quality.mjs --page X    # Check specific page
 *   node scripts/validate-quality.mjs --ci        # JSON output for CI
 *
 * Exit codes:
 *   0 = No large discrepancies found
 *   1 = Large discrepancies found (quality claimed >= 20 points higher than structure suggests)
 */

import { loadPages as loadPagesData } from '../lib/content-types.js';

// Parse args
const args = process.argv.slice(2);
const CI_MODE = args.includes('--ci');
const LARGE_ONLY = args.includes('--large');
const PAGE_FILTER = args.includes('--page')
  ? args[args.indexOf('--page') + 1]
  : null;

// ANSI colors
const colors = CI_MODE ? {
  reset: '', bold: '', dim: '',
  red: '', yellow: '', green: '', blue: '', cyan: ''
} : {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
  blue: '\x1b[34m', cyan: '\x1b[36m'
};

function loadPages() {
  const pages = loadPagesData();
  if (pages.length === 0) {
    console.error('Error: pages.json not found or empty. Run `pnpm build` first.');
    process.exit(1);
  }
  return pages;
}

function getDiscrepancyLevel(quality, suggested) {
  const diff = quality - suggested;
  // 0-100 scale: 20+ points is a major discrepancy (one full tier)
  if (diff >= 20) return 'overrated';      // Claimed much higher than structure
  if (diff >= 10) return 'slight-over';    // Slightly overrated
  if (Math.abs(diff) < 10) return 'ok';    // Within acceptable range
  if (diff >= -20) return 'slight-under';  // Slightly underrated
  return 'underrated';                      // Could be rated higher
}

function formatMetrics(metrics) {
  if (!metrics) return 'No metrics';

  const parts = [];
  parts.push(`📊 ${metrics.tableCount} tables`);
  parts.push(`📈 ${metrics.diagramCount} diagrams`);
  parts.push(`🔗 ${metrics.internalLinks} internal`);
  parts.push(`📚 ${metrics.externalLinks} external`);
  parts.push(`• ${Math.round(metrics.bulletRatio * 100)}% bullets`);
  parts.push(`📝 ${metrics.wordCount} words`);

  return parts.join(' | ');
}

function getImprovementSuggestions(metrics, currentQuality, targetQuality) {
  if (!metrics) return [];

  const suggestions = [];
  const neededPoints = (targetQuality - 1) * 3; // Rough mapping

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

function main() {
  const pages = loadPages();

  // Filter and analyze
  let candidates = pages.filter(p =>
    p.quality !== null &&
    p.suggestedQuality !== null
  );

  if (PAGE_FILTER) {
    candidates = candidates.filter(p =>
      p.id.includes(PAGE_FILTER) ||
      p.path.includes(PAGE_FILTER) ||
      p.title.toLowerCase().includes(PAGE_FILTER.toLowerCase())
    );
  }

  // Categorize by discrepancy
  const overrated = [];     // quality > suggested by 2+
  const slightOver = [];    // quality > suggested by 1
  const ok = [];            // quality == suggested
  const slightUnder = [];   // quality < suggested by 1
  const underrated = [];    // quality < suggested by 2+

  for (const page of candidates) {
    const level = getDiscrepancyLevel(page.quality, page.suggestedQuality);
    const entry = {
      ...page,
      discrepancy: page.quality - page.suggestedQuality,
      level,
    };

    if (level === 'overrated') overrated.push(entry);
    else if (level === 'slight-over') slightOver.push(entry);
    else if (level === 'ok') ok.push(entry);
    else if (level === 'slight-under') slightUnder.push(entry);
    else underrated.push(entry);
  }

  // Sort by discrepancy magnitude
  overrated.sort((a, b) => b.discrepancy - a.discrepancy);
  slightOver.sort((a, b) => b.discrepancy - a.discrepancy);
  underrated.sort((a, b) => a.discrepancy - b.discrepancy);
  slightUnder.sort((a, b) => a.discrepancy - b.discrepancy);

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
    process.exit(overrated.length > 0 ? 1 : 0);
  }

  // Human-readable output
  console.log(`\n${colors.bold}Quality Discrepancy Report${colors.reset}\n`);
  console.log(`Checked ${candidates.length} pages with quality ratings\n`);

  // Summary bar
  const total = candidates.length;
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
      console.log(`  ${formatMetrics(page.metrics)}`);

      const suggestions = getImprovementSuggestions(page.metrics, page.quality, page.quality);
      if (suggestions.length > 0) {
        console.log(`  ${colors.cyan}To justify Q${page.quality}:${colors.reset}`);
        suggestions.forEach(s => console.log(`    → ${s}`));
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
    const firstPage = overrated[0];
    console.log(`  npm run regrade -- ${firstPage.id}\n`);

    // Batch command for all overrated
    if (overrated.length > 1) {
      console.log(`${colors.cyan}Re-grade all ${overrated.length} overrated pages:${colors.reset}`);
      const ids = overrated.map(p => p.id).join(' ');
      console.log(`  npm run regrade -- ${ids}\n`);
    }

    // Or manual fix for stubs
    const stubs = overrated.filter(p => p.path.includes('stub') || (p.metrics?.wordCount || 0) < 200);
    if (stubs.length > 0) {
      console.log(`${colors.cyan}Or manually lower quality for stub/short pages:${colors.reset}`);
      stubs.forEach(p => {
        console.log(`  ${p.id}: quality ${p.quality} → ~${Math.min(35, p.suggestedQuality)}`);
      });
      console.log();
    }

    process.exit(1);
  } else {
    console.log(`${colors.green}No significantly overrated pages found.${colors.reset}\n`);
    process.exit(0);
  }
}

main();
