#!/usr/bin/env node

/**
 * Unified Wiki Health Analysis
 *
 * Runs all analysis tools and produces a combined report:
 * - Entity mentions (unlinked cross-references)
 * - Link coverage (orphans, underlinked pages)
 *
 * Usage:
 *   node crux/analyze/analyze-all.mjs           # Full health report
 *   node crux/analyze/analyze-all.mjs --json    # JSON output
 *   node crux/analyze/analyze-all.mjs --brief   # Summary only
 */

import { ValidationEngine } from '../lib/validation-engine.js';
import { entityMentionsRule } from '../lib/rules/entity-mentions.js';
import { getColors } from '../lib/output.mjs';
import { PROJECT_ROOT, loadBacklinks, loadEntities } from '../lib/content-types.js';

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
  const backlinks = loadBacklinks();
  const entities = loadEntities();

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
  const orphans = [];
  const linkCounts = [];

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
    console.log(`${colors.dim}Run specific tools: node crux/crux.mjs analyze mentions | node crux/crux.mjs analyze links${colors.reset}`);
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
