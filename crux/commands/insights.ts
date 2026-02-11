/**
 * Insights Command Handlers
 *
 * Thin layer between CLI and library:
 * - Parses command-specific options
 * - Calls library functions
 * - Formats output for display
 */

import type { Insight, InsightsData, CheckResult, AllChecksResult, InsightStats, RatingDistribution, DuplicatePair } from '../lib/insights.ts';
import type { CommandResult } from '../lib/cli.ts';
import type { Logger } from '../lib/output.ts';
import * as lib from '../lib/insights.ts';
import { createLogger, formatCount } from '../lib/output.ts';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the repo root
const REPO_ROOT: string = join(__dirname, '..', '..');
const INSIGHTS_PATH: string = join(REPO_ROOT, 'data', 'insights.yaml');
const CONTENT_DIR: string = join(REPO_ROOT, 'content', 'docs');

/**
 * Default command - run all checks
 */
export async function check(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  const insights = data.insights || [];

  const result = lib.runAllChecks(insights, CONTENT_DIR, {
    only: (options.only as string)?.split(','),
    skip: (options.skip as string)?.split(','),
  });

  if (options.ci) {
    return { output: JSON.stringify(result, null, 2), exitCode: result.passed ? 0 : 1 };
  }

  // Human-readable output
  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Insights Quality Check${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n\n`;

  for (const [checkName, checkResult] of Object.entries(result.results)) {
    const icon = checkResult.passed ? `${c.green}✓` : `${c.red}✗`;
    output += `${icon} ${checkName}${c.reset}`;

    if (checkResult.issues.length > 0) {
      output += ` (${checkResult.issues.length} issues)\n`;

      // Show first few issues
      const showCount = Math.min(checkResult.issues.length, 5);
      for (let i = 0; i < showCount; i++) {
        const issue = checkResult.issues[i];
        const severity = issue.severity === 'error' ? c.red : issue.severity === 'warning' ? c.yellow : c.dim;
        output += `  ${severity}${issue.message}${c.reset}\n`;
      }
      if (checkResult.issues.length > showCount) {
        output += `  ${c.dim}... and ${checkResult.issues.length - showCount} more${c.reset}\n`;
      }
    } else {
      output += '\n';
    }
    output += '\n';
  }

  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n`;
  output += `Total: ${result.total} insights, ${result.checksRun} checks, ${result.totalIssues} issues\n`;

  if (result.passed) {
    output += `${c.green}${c.bold}All checks passed!${c.reset}\n`;
  } else {
    output += `${c.red}${c.bold}Some checks failed${c.reset}\n`;
  }

  return { output, exitCode: result.passed ? 0 : 1 };
}

/**
 * Check for duplicate insights
 */
export async function duplicates(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  const insights = data.insights || [];

  const threshold = parseFloat((options.threshold as string) || '0.7');
  const result = lib.checkDuplicates(insights, { threshold });

  if (options.ci) {
    return { output: JSON.stringify(result, null, 2), exitCode: result.passed ? 0 : 1 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Duplicate Insights Check${c.reset}\n`;
  output += `${c.dim}Threshold: ${threshold * 100}% similarity${c.reset}\n\n`;

  if (result.pairs && result.pairs.length > 0) {
    for (const pair of result.pairs) {
      output += `${c.yellow}${pair.id1} ↔ ${pair.id2}${c.reset} (${Math.round(pair.similarity * 100)}%)\n`;
      output += `  ${c.dim}${pair.text1}${c.reset}\n`;
      output += `  ${c.dim}${pair.text2}${c.reset}\n\n`;
    }
  } else {
    output += `${c.green}No duplicates found above ${threshold * 100}% threshold${c.reset}\n`;
  }

  output += `\n${c.dim}Checked ${(result.stats as Record<string, unknown>)?.pairsChecked} pairs${c.reset}\n`;

  return { output, exitCode: result.passed ? 0 : 1 };
}

/**
 * Check rating calibration
 */
export async function ratings(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  const insights = data.insights || [];

  const result = lib.checkRatings(insights);

  if (options.ci) {
    return { output: JSON.stringify(result, null, 2), exitCode: result.passed ? 0 : 1 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Rating Calibration Check${c.reset}\n\n`;

  // Show distributions
  if (result.stats?.distributions) {
    output += `${c.bold}Rating Distributions:${c.reset}\n`;
    for (const [field, dist] of Object.entries(result.stats.distributions as Record<string, RatingDistribution>)) {
      output += `  ${field}: min=${dist.min}, max=${dist.max}, mean=${dist.mean.toFixed(2)}, median=${dist.median}\n`;
    }
    output += '\n';
  }

  // Show issues
  if (result.issues.length > 0) {
    output += `${c.bold}Issues:${c.reset}\n`;
    for (const issue of result.issues) {
      const icon = issue.severity === 'error' ? `${c.red}✗` : `${c.yellow}⚠`;
      output += `  ${icon} ${issue.message}${c.reset}\n`;
    }
  } else {
    output += `${c.green}No rating issues found${c.reset}\n`;
  }

  return { output, exitCode: result.passed ? 0 : 1 };
}

/**
 * Check source paths
 */
export async function sources(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  const insights = data.insights || [];

  const result = lib.checkSources(insights, CONTENT_DIR);

  if (options.ci) {
    return { output: JSON.stringify(result, null, 2), exitCode: result.passed ? 0 : 1 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Source Path Check${c.reset}\n\n`;

  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      const icon = issue.severity === 'error' ? `${c.red}✗` : `${c.yellow}⚠`;
      output += `${icon} ${issue.message}${c.reset}\n`;
    }
  }

  output += `\n${c.dim}Valid: ${(result.stats as Record<string, unknown>)?.validSources}, Invalid: ${(result.stats as Record<string, unknown>)?.invalidSources}${c.reset}\n`;

  return { output, exitCode: result.passed ? 0 : 1 };
}

/**
 * Check for stale insights
 */
export async function staleness(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  const insights = data.insights || [];

  const staleDays = parseInt((options.days as string) || '90', 10);
  const result = lib.checkStaleness(insights, { staleDays });

  if (options.ci) {
    return { output: JSON.stringify(result, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Staleness Check${c.reset}\n`;
  output += `${c.dim}Threshold: ${staleDays} days${c.reset}\n\n`;

  output += `Recent: ${c.green}${(result.stats as Record<string, unknown>)?.recent}${c.reset}\n`;
  output += `Stale: ${c.yellow}${(result.stats as Record<string, unknown>)?.stale}${c.reset}\n`;
  output += `Unverified: ${c.dim}${(result.stats as Record<string, unknown>)?.unverified}${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Show statistics
 */
export async function stats(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  const insights = data.insights || [];

  const stats = lib.computeStats(insights);

  if (options.ci || options.json) {
    return { output: JSON.stringify(stats, null, 2), exitCode: 0 };
  }

  const c = log.colors;
  let output = '';

  output += `${c.bold}${c.blue}Insights Statistics${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n\n`;

  output += `${c.bold}Total:${c.reset} ${stats.total} insights\n\n`;

  output += `${c.bold}By Type:${c.reset}\n`;
  for (const [type, count] of Object.entries(stats.byType)) {
    output += `  ${type}: ${count}\n`;
  }
  output += '\n';

  output += `${c.bold}Top Tags:${c.reset}\n`;
  for (const { tag, count } of stats.topTags.slice(0, 10)) {
    output += `  ${tag}: ${count}\n`;
  }
  output += '\n';

  output += `${c.bold}Rating Distributions:${c.reset}\n`;
  for (const [field, dist] of Object.entries(stats.ratings)) {
    output += `  ${field}: ${dist.min}-${dist.max} (mean: ${dist.mean}, median: ${dist.median})\n`;
  }
  output += '\n';

  output += `${c.bold}Verification:${c.reset}\n`;
  output += `  Verified: ${stats.verification.verified} (${stats.verification.percentVerified}%)\n`;
  output += `  Unverified: ${stats.verification.unverified}\n`;
  output += '\n';

  output += `${c.bold}Top by Composite Score:${c.reset}\n`;
  for (const item of stats.topByComposite.slice(0, 5)) {
    output += `  ${c.cyan}${item.id}${c.reset} (${item.composite}): ${item.text}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Apply fixes to insights
 */
export async function fix(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const data = lib.loadInsights(INSIGHTS_PATH);
  let insights = data.insights || [];

  const c = log.colors;
  let output = '';
  const changes: string[] = [];

  // Add verification dates
  if (options.addVerified) {
    const before = insights.filter((i: Insight) => !i.lastVerified).length;
    insights = lib.addVerificationDates(insights);
    changes.push(`Added lastVerified to ${before} insights`);
  }

  // Normalize ratings
  if (options.normalizeRatings) {
    insights = lib.normalizeRatings(insights);
    changes.push('Normalized all ratings to [1-5] range');
  }

  if (changes.length === 0) {
    output += `${c.yellow}No fixes specified. Available fixes:${c.reset}\n`;
    output += `  --add-verified     Add lastVerified date to insights without one\n`;
    output += `  --normalize-ratings  Clamp ratings to [1-5] range\n`;
    return { output, exitCode: 0 };
  }

  if (options.dryRun) {
    output += `${c.bold}${c.blue}Dry Run - Changes to apply:${c.reset}\n`;
    for (const change of changes) {
      output += `  ${c.cyan}${change}${c.reset}\n`;
    }
    output += `\n${c.yellow}Use --apply to actually apply changes${c.reset}\n`;
  } else if (options.apply) {
    lib.saveInsights(INSIGHTS_PATH, { ...data, insights });
    output += `${c.bold}${c.green}Applied fixes:${c.reset}\n`;
    for (const change of changes) {
      output += `  ${c.green}✓ ${change}${c.reset}\n`;
    }
  } else {
    output += `${c.bold}Changes to apply:${c.reset}\n`;
    for (const change of changes) {
      output += `  ${change}\n`;
    }
    output += `\n${c.yellow}Use --dry-run to preview or --apply to save${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Command registry
 */
export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {
  check,
  duplicates,
  ratings,
  sources,
  staleness,
  stats,
  fix,
};

/**
 * Get help text for insights domain
 */
export function getHelp(): string {
  return `
Insights Domain - Insight quality management

Commands:
  check                Run all quality checks (default)
  duplicates           Find similar insights
  ratings              Check rating calibration
  sources              Verify source paths exist
  staleness            Find unverified/stale insights
  stats                Show statistics
  fix                  Apply fixes

Options:
  --ci                 JSON output for CI pipelines
  --threshold=N        Similarity threshold for duplicates (default: 0.7)
  --days=N             Staleness threshold in days (default: 90)
  --json               Output as JSON
  --only=a,b           Run only specified checks
  --skip=a,b           Skip specified checks
  --dry-run            Preview changes without applying
  --apply              Apply changes (for fix command)
  --add-verified       Add lastVerified date
  --normalize-ratings  Clamp ratings to [1-5]

Examples:
  crux insights check
  crux insights duplicates --threshold 0.5
  crux insights stats --json
  crux insights fix --add-verified --dry-run
`;
}
