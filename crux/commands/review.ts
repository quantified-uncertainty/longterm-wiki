/**
 * Review Command Handlers
 *
 * Track human review status for wiki pages. Distinguishes AI-drafted
 * content from human-verified content with a review history per page.
 *
 * Usage:
 *   crux review mark <page-id> --reviewer="name"    Mark page as reviewed
 *   crux review status <page-id>                     Show review status
 *   crux review list                                 List reviewed pages
 *   crux review stats                                Review coverage statistics
 *
 * Part of the hallucination risk reduction initiative (issue #200, Phase 4).
 */

import { type CommandResult, parseIntOpt } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import {
  markReviewed,
  getReviewStatus,
  listAllReviews,
} from '../lib/review-tracking.ts';

/**
 * Mark a page as reviewed by a human
 */
export async function mark(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a: string) => !a.startsWith('-'));
  if (!pageId) {
    return {
      output: `${c.red}Error: page ID required. Usage: crux review mark <page-id> --reviewer="name"${c.reset}`,
      exitCode: 1,
    };
  }

  const reviewer = options.reviewer as string;
  if (!reviewer) {
    return {
      output: `${c.red}Error: --reviewer is required. Usage: crux review mark <page-id> --reviewer="name"${c.reset}`,
      exitCode: 1,
    };
  }

  const scope = (options.scope as string) || 'full';
  const note = options.note as string | undefined;

  const entry = markReviewed(pageId, { reviewer, scope, note });

  if (options.ci || options.json) {
    return { output: JSON.stringify(entry, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.green}Marked ${pageId} as reviewed${c.reset}\n`;
  output += `  Reviewer: ${c.bold}${entry.reviewer}${c.reset}\n`;
  output += `  Date:     ${entry.date}\n`;
  output += `  Scope:    ${scope}\n`;
  if (note) output += `  Note:     ${note}\n`;

  return { output, exitCode: 0 };
}

/**
 * Show review status for a specific page
 */
export async function status(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a: string) => !a.startsWith('-'));
  if (!pageId) {
    return {
      output: `${c.red}Error: page ID required. Usage: crux review status <page-id>${c.reset}`,
      exitCode: 1,
    };
  }

  const reviewStatus = getReviewStatus(pageId);

  if (options.ci || options.json) {
    return { output: JSON.stringify(reviewStatus, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Review Status: ${pageId}${c.reset}\n\n`;

  if (!reviewStatus.reviewed) {
    output += `  ${c.yellow}Not yet reviewed by a human${c.reset}\n`;
    output += `\n  ${c.dim}Mark as reviewed: crux review mark ${pageId} --reviewer="your-name"${c.reset}\n`;
  } else {
    output += `  ${c.green}Reviewed${c.reset}\n`;
    output += `  Last review:  ${c.bold}${reviewStatus.lastReviewDate}${c.reset}`;
    if (reviewStatus.daysSinceReview !== null) {
      output += ` (${reviewStatus.daysSinceReview} days ago)`;
    }
    output += '\n';
    output += `  Reviewer:     ${reviewStatus.lastReviewer}\n`;
    output += `  Total reviews: ${reviewStatus.reviewCount}\n`;

    if (reviewStatus.daysSinceReview !== null && reviewStatus.daysSinceReview > 90) {
      output += `\n  ${c.yellow}Review is stale (>90 days). Consider re-reviewing.${c.reset}\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * List all reviewed pages
 */
export async function list(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const limit = parseIntOpt(options.limit, 50);
  const allReviews = listAllReviews();
  const reviews = allReviews.slice(0, limit);

  if (options.ci || options.json) {
    return { output: JSON.stringify(reviews, null, 2), exitCode: 0 };
  }

  if (reviews.length === 0) {
    let output = `${c.dim}No reviews recorded yet.${c.reset}\n`;
    output += `\n${c.dim}Mark a page: crux review mark <page-id> --reviewer="your-name"${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Reviewed Pages${c.reset}\n`;
  output += `${c.dim}${reviews.length} of ${allReviews.length} reviewed pages${c.reset}\n\n`;

  output += `${c.bold}${'Last Review'.padEnd(12)} ${'#'.padStart(3)}  ${'Reviewer'.padEnd(16)} ${'Days'.padStart(5)}  Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(70)}${c.reset}\n`;

  for (const r of reviews) {
    const days = r.daysSinceReview !== null ? String(r.daysSinceReview) : '-';
    const daysColor = r.daysSinceReview !== null && r.daysSinceReview > 90 ? c.yellow : '';
    output += `${r.lastReviewDate || '-'}  ${String(r.reviewCount).padStart(3)}  ${(r.lastReviewer || '-').padEnd(16)} ${daysColor}${days.padStart(5)}${c.reset}  ${r.pageId}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Show review coverage statistics
 */
export async function stats(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const allReviews = listAllReviews();

  const reviewerCounts: Record<string, number> = {};
  for (const r of allReviews) {
    if (r.lastReviewer) {
      reviewerCounts[r.lastReviewer] = (reviewerCounts[r.lastReviewer] || 0) + 1;
    }
  }

  const stale = allReviews.filter(r => r.daysSinceReview !== null && r.daysSinceReview > 90);

  const statsData = {
    reviewedPages: allReviews.length,
    staleReviews: stale.length,
    byReviewer: reviewerCounts,
  };

  if (options.ci || options.json) {
    return { output: JSON.stringify(statsData, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Review Statistics${c.reset}\n\n`;
  output += `  Reviewed pages:  ${c.bold}${allReviews.length}${c.reset}\n`;
  output += `  Stale reviews:   ${stale.length > 0 ? c.yellow : ''}${stale.length}${c.reset}\n\n`;

  if (Object.keys(reviewerCounts).length > 0) {
    output += `${c.bold}By Reviewer:${c.reset}\n`;
    for (const [reviewer, count] of Object.entries(reviewerCounts).sort((a, b) => b[1] - a[1])) {
      output += `  ${reviewer.padEnd(20)} ${String(count).padStart(5)}\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Command registry
 */
export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {
  mark,
  status,
  list,
  stats,
  default: list,
};

/**
 * Get help text
 */
export function getHelp(): string {
  return `
Review Domain - Track human review status for wiki pages

Commands:
  mark <page-id>       Mark a page as reviewed by a human
  status <page-id>     Show review status for a specific page
  list                 List all reviewed pages (default)
  stats                Show review coverage statistics

Options:
  --reviewer=<name>    Reviewer name (required for mark)
  --scope=<scope>      Review scope: full, citations, facts, partial (default: full)
  --note="<text>"      Free-text note about what was checked
  --json               Output as JSON
  --ci                 JSON output for CI pipelines
  --limit=N            Number of results for list (default: 50)

Examples:
  crux review mark open-philanthropy --reviewer="ozzie" --note="Verified funding data"
  crux review status dan-hendrycks
  crux review list
  crux review stats
`;
}
