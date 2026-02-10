#!/usr/bin/env node

/**
 * Unified Wiki Health Analysis
 *
 * Runs all analysis tools and produces a combined report:
 * - Entity mentions (unlinked cross-references)
 * - Link coverage (orphans, underlinked pages)
 *
 * Usage:
 *   node tooling/analyze/analyze-all.mjs           # Full health report
 *   node tooling/analyze/analyze-all.mjs --json    # JSON output
 *   node tooling/analyze/analyze-all.mjs --brief   # Summary only
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ValidationEngine } from '../lib/validation-engine.mjs';
import { entityMentionsRule } from '../lib/rules/entity-mentions.mjs';
import { getColors } from '../lib/output.mjs';
import { GENERATED_DATA_DIR_ABS as DATA_DIR } from '../lib/content-types.mjs';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const BRIEF_MODE = args.includes('--brief');
const colors = getColors(JSON_MODE);

/**
 * Run entity mentions analysis
 */
async function analyzeEntityMentions() {
  const engine = new ValidationEngine();
  engine.addRule(entityMentionsRule);
  await engine.load();

  const issues = await engine.validate({ ruleIds: ['entity-mentions'] });

  // Group by file
  const byFile = {};
  for (const issue of issues) {
    if (!byFile[issue.file]) byFile[issue.file] = [];
    byFile[issue.file].push(issue);
  }

  return {
    name: 'Entity Mentions',
    description: 'Unlinked references to known entities',
    totalIssues: issues.length,
    filesAffected: Object.keys(byFile).length,
    topFiles: Object.entries(byFile)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([file, issues]) => ({ file: file.replace(PROJECT_ROOT + '/', ''), count: issues.length })),
    issues: BRIEF_MODE ? [] : issues.slice(0, 20)
  };
}

/**
 * Run link coverage analysis
 */
async function analyzeLinkCoverage() {
  const backlinksPath = join(DATA_DIR, 'backlinks.json');
  const databasePath = join(DATA_DIR, 'database.json');

  if (!existsSync(backlinksPath) || !existsSync(databasePath)) {
    return {
      name: 'Link Coverage',
      description: 'Cross-reference density analysis',
      error: 'Run pnpm build first',
      totalIssues: 0,
      orphanPages: [],
      stats: null
    };
  }

  const backlinks = JSON.parse(readFileSync(backlinksPath, 'utf-8'));
  const database = JSON.parse(readFileSync(databasePath, 'utf-8'));

  // Calculate orphan pages (≤1 incoming link)
  const orphans = [];
  const linkCounts = [];

  for (const [entityId, entity] of Object.entries(database)) {
    const incomingLinks = backlinks[entityId] || [];
    const count = incomingLinks.length;
    linkCounts.push(count);

    if (count <= 1 && entity.type !== 'overview') {
      orphans.push({
        id: entityId,
        title: entity.title || entityId,
        incomingLinks: count,
        type: entity.type
      });
    }
  }

  // Calculate stats
  const totalPages = linkCounts.length;
  const avgLinks = linkCounts.reduce((a, b) => a + b, 0) / totalPages;
  const orphanCount = orphans.length;

  return {
    name: 'Link Coverage',
    description: 'Cross-reference density analysis',
    stats: {
      totalPages,
      averageIncomingLinks: avgLinks.toFixed(1),
      orphanPages: orphanCount,
      orphanPercent: ((orphanCount / totalPages) * 100).toFixed(1) + '%'
    },
    orphanPages: orphans
      .sort((a, b) => a.incomingLinks - b.incomingLinks)
      .slice(0, 10)
  };
}

/**
 * Main analysis runner
 */
async function main() {
  const startTime = Date.now();

  if (!JSON_MODE && !BRIEF_MODE) {
    console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.blue}                    Wiki Health Report                       ${colors.reset}`);
    console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  }

  // Run all analyses
  const [entityMentions, linkCoverage] = await Promise.all([
    analyzeEntityMentions(),
    analyzeLinkCoverage()
  ]);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  const report = {
    timestamp: new Date().toISOString(),
    duration,
    analyses: [entityMentions, linkCoverage],
    summary: {
      totalIssues: entityMentions.totalIssues,
      orphanPages: linkCoverage.stats?.orphanPages || 0,
      healthScore: calculateHealthScore(entityMentions, linkCoverage)
    }
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Print entity mentions section
  console.log(`${colors.yellow}📝 Entity Mentions${colors.reset}`);
  console.log(`   ${entityMentions.description}`);
  console.log(`   Found ${colors.cyan}${entityMentions.totalIssues}${colors.reset} unlinked mentions across ${entityMentions.filesAffected} files`);

  if (entityMentions.topFiles.length > 0 && !BRIEF_MODE) {
    console.log(`\n   Top files with opportunities:`);
    for (const { file, count } of entityMentions.topFiles) {
      console.log(`   ${colors.dim}•${colors.reset} ${file} (${count})`);
    }
  }

  // Print link coverage section
  console.log(`\n${colors.yellow}🔗 Link Coverage${colors.reset}`);
  console.log(`   ${linkCoverage.description}`);

  if (linkCoverage.stats) {
    console.log(`   Total pages: ${colors.cyan}${linkCoverage.stats.totalPages}${colors.reset}`);
    console.log(`   Average incoming links: ${colors.cyan}${linkCoverage.stats.averageIncomingLinks}${colors.reset}`);
    console.log(`   Orphan pages (≤1 link): ${colors.cyan}${linkCoverage.stats.orphanPages}${colors.reset} (${linkCoverage.stats.orphanPercent})`);

    if (linkCoverage.orphanPages.length > 0 && !BRIEF_MODE) {
      console.log(`\n   Most isolated pages:`);
      for (const page of linkCoverage.orphanPages.slice(0, 5)) {
        console.log(`   ${colors.dim}•${colors.reset} ${page.title} (${page.incomingLinks} links)`);
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
    console.log(`${colors.dim}Run specific tools: node tooling/crux.mjs analyze mentions | node tooling/crux.mjs analyze links${colors.reset}`);
  }
}

/**
 * Calculate a simple health score based on analysis results
 */
function calculateHealthScore(entityMentions, linkCoverage) {
  let score = 100;

  // Deduct for unlinked mentions (up to 30 points)
  const mentionPenalty = Math.min(30, entityMentions.totalIssues * 0.5);
  score -= mentionPenalty;

  // Deduct for orphan pages (up to 40 points)
  if (linkCoverage.stats) {
    const orphanPercent = parseFloat(linkCoverage.stats.orphanPercent);
    const orphanPenalty = Math.min(40, orphanPercent * 2);
    score -= orphanPenalty;
  }

  return Math.max(0, Math.round(score));
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
