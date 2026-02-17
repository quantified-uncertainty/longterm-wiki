#!/usr/bin/env node

/**
 * Unified Wiki Health Analysis
 *
 * Runs all analysis tools and produces a combined report:
 * - Link coverage (orphans, underlinked pages)
 *
 * Usage:
 *   node crux/analyze/analyze-all.ts           # Full health report
 *   node crux/analyze/analyze-all.ts --json    # JSON output
 *   node crux/analyze/analyze-all.ts --brief   # Summary only
 */

import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT, loadBacklinks, loadEntities, type Entity, type BacklinksMap } from '../lib/content-types.ts';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const BRIEF_MODE = args.includes('--brief');
const colors = getColors(JSON_MODE);

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface LinkCoverageStats {
  totalPages: number;
  averageIncomingLinks: string;
  orphanPages: number;
  orphanPercent: string;
}

interface OrphanPage {
  id: string;
  title: string;
  incomingLinks: number;
  type: string | undefined;
}

interface LinkCoverageResult {
  name: string;
  description: string;
  error?: string;
  totalIssues?: number;
  stats: LinkCoverageStats | null;
  orphanPages: OrphanPage[];
}

interface ReportSummary {
  orphanPages: number;
  healthScore: number;
}

interface Report {
  timestamp: string;
  duration: string;
  analyses: [LinkCoverageResult];
  summary: ReportSummary;
}

/**
 * Run link coverage analysis
 */
async function analyzeLinkCoverage(): Promise<LinkCoverageResult> {
  const backlinks: BacklinksMap = loadBacklinks();
  const entities: Entity[] = loadEntities();

  if (entities.length === 0) {
    return {
      name: 'Link Coverage',
      description: 'Cross-reference density analysis',
      error: 'Run pnpm build first',
      totalIssues: 0,
      orphanPages: [],
      stats: null
    };
  }

  // Calculate orphan pages (≤1 incoming link)
  const orphans: OrphanPage[] = [];
  const linkCounts: number[] = [];

  for (const entity of entities) {
    const incomingLinks = backlinks[entity.id] || [];
    const count = incomingLinks.length;
    linkCounts.push(count);

    if (count <= 1) {
      orphans.push({
        id: entity.id,
        title: entity.title || entity.id,
        incomingLinks: count,
        type: entity.entityType || entity.type
      });
    }
  }

  // Calculate stats
  const totalPages = linkCounts.length;
  const avgLinks = totalPages > 0 ? linkCounts.reduce((a, b) => a + b, 0) / totalPages : 0;
  const orphanCount = orphans.length;

  return {
    name: 'Link Coverage',
    description: 'Cross-reference density analysis',
    stats: {
      totalPages,
      averageIncomingLinks: avgLinks.toFixed(1),
      orphanPages: orphanCount,
      orphanPercent: totalPages > 0 ? ((orphanCount / totalPages) * 100).toFixed(1) + '%' : '0%'
    },
    orphanPages: orphans
      .sort((a, b) => a.incomingLinks - b.incomingLinks)
      .slice(0, 10)
  };
}

/**
 * Main analysis runner
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  if (!JSON_MODE && !BRIEF_MODE) {
    console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.blue}                    Wiki Health Report                       ${colors.reset}`);
    console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  }

  // Run all analyses
  const linkCoverage = await analyzeLinkCoverage();

  const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  const report: Report = {
    timestamp: new Date().toISOString(),
    duration,
    analyses: [linkCoverage],
    summary: {
      orphanPages: linkCoverage.stats?.orphanPages || 0,
      healthScore: calculateHealthScore(linkCoverage)
    }
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Print link coverage section
  console.log(`${colors.yellow}Link Coverage${colors.reset}`);
  console.log(`   ${linkCoverage.description}`);

  if (linkCoverage.stats) {
    console.log(`   Total pages: ${colors.cyan}${linkCoverage.stats.totalPages}${colors.reset}`);
    console.log(`   Average incoming links: ${colors.cyan}${linkCoverage.stats.averageIncomingLinks}${colors.reset}`);
    console.log(`   Orphan pages (≤1 link): ${colors.cyan}${linkCoverage.stats.orphanPages}${colors.reset} (${linkCoverage.stats.orphanPercent})`);

    if (linkCoverage.orphanPages.length > 0 && !BRIEF_MODE) {
      console.log(`\n   Most isolated pages:`);
      for (const page of linkCoverage.orphanPages.slice(0, 5)) {
        console.log(`   ${colors.dim}-${colors.reset} ${page.title} (${page.incomingLinks} links)`);
      }
    }
  } else if (linkCoverage.error) {
    console.log(`   ${colors.red}Error: ${linkCoverage.error}${colors.reset}`);
  }

  // Print summary
  console.log(`\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.green}Health Score: ${report.summary.healthScore}/100${colors.reset}`);
  console.log(`${colors.dim}Completed in ${duration}${colors.reset}`);

  if (!BRIEF_MODE) {
    console.log(`\n${colors.dim}Run with --json for machine-readable output${colors.reset}`);
    console.log(`${colors.dim}Run specific tools: node crux/crux.mjs analyze links${colors.reset}`);
  }
}

/**
 * Calculate a simple health score based on analysis results
 */
function calculateHealthScore(linkCoverage: LinkCoverageResult): number {
  let score = 100;

  // Deduct for orphan pages (up to 40 points)
  if (linkCoverage.stats) {
    const orphanPercent = parseFloat(linkCoverage.stats.orphanPercent);
    const orphanPenalty = Math.min(40, orphanPercent * 2);
    score -= orphanPenalty;
  }

  return Math.max(0, Math.round(score));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('Analysis failed:', err);
    process.exit(1);
  });
}
