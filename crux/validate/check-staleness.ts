#!/usr/bin/env node

/**
 * Content Staleness Detection Script
 *
 * Checks for stale content based on:
 * - reviewBy dates in frontmatter (past due)
 * - contentDependencies that have been updated more recently
 * - Time since lastEdited (threshold varies by content type)
 *
 * Usage: npx tsx crux/validate/check-staleness.ts [--ci] [--json]
 *
 * Options:
 *   --ci      Output JSON for CI pipelines
 *   --json    Output JSON (same as --ci)
 *
 * Exit codes:
 *   0 = No urgent staleness issues
 *   1 = Pages significantly past review date (>30 days)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import { getContentType, getStalenessThreshold, CONTENT_DIR, DEFAULT_STALENESS_THRESHOLD } from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';
import type { Colors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StalenessIssue {
  id: string;
  severity: 'warning' | 'info';
  description: string;
  daysPast?: number;
  reviewBy?: string;
  daysSinceEdit?: number;
  lastEdited?: string;
  threshold?: number;
  suggestion?: string;
  dependencyId?: string;
  daysBehind?: number;
  dependencyDate?: string;
  thisDate?: string;
}

interface FileWithIssues {
  file: string;
  issues: StalenessIssue[];
  contentType: string;
}

type EntityDateMap = Record<string, Date | null>;

interface StalenessStats {
  totalFiles: number;
  withReviewBy: number;
  withLastEdited: number;
  withDependencies: number;
}

interface Frontmatter {
  reviewBy?: string;
  lastEdited?: string;
  contentDependencies?: string[];
  [key: string]: unknown;
}

interface StalenessCheckOptions extends ValidatorOptions {
  ci?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a date string (YYYY-MM-DD or YYYY-MM) to Date object
 */
function parseDate(dateStr: string | undefined | null): Date | null {
  if (!dateStr) return null;
  // Handle both YYYY-MM-DD and YYYY-MM formats
  const parts = dateStr.split('-');
  if (parts.length === 2) {
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
  }
  return new Date(dateStr);
}

/**
 * Calculate days between two dates
 */
function daysBetween(date1: Date, date2: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((date2.getTime() - date1.getTime()) / msPerDay);
}

/**
 * Build a map of entity IDs to their lastEdited dates
 */
function buildEntityDateMap(files: string[]): EntityDateMap {
  const map: EntityDateMap = {};
  for (const file of files) {
    try {
      const content: string = readFileSync(file, 'utf-8');
      const fm = parseFrontmatter(content) as Frontmatter;
      // Extract entity ID from filename
      const filename: string = file.split('/').pop()!.replace(/\.(mdx?|md)$/, '');
      if (fm.lastEdited) {
        map[filename] = parseDate(fm.lastEdited);
      }
    } catch {
      // Skip files that can't be read
    }
  }
  return map;
}

/**
 * Check a single file for staleness
 */
function checkStaleness(
  filePath: string,
  frontmatter: Frontmatter,
  contentType: string,
  entityDateMap: EntityDateMap,
  today: Date,
): StalenessIssue[] {
  const issues: StalenessIssue[] = [];

  // Check 1: Past reviewBy date
  if (frontmatter.reviewBy) {
    const reviewDate: Date | null = parseDate(frontmatter.reviewBy);
    if (reviewDate && reviewDate < today) {
      const daysPast: number = daysBetween(reviewDate, today);
      issues.push({
        id: 'past-review-date',
        severity: daysPast > 30 ? 'warning' : 'info',
        daysPast,
        reviewBy: frontmatter.reviewBy,
        description: `Review date was ${daysPast} days ago (${frontmatter.reviewBy})`,
      });
    }
  }

  // Check 2: No reviewBy but old lastEdited
  if (!frontmatter.reviewBy && frontmatter.lastEdited) {
    const lastEdit: Date | null = parseDate(frontmatter.lastEdited);
    const threshold: number = getStalenessThreshold(contentType);

    if (lastEdit) {
      const daysSinceEdit: number = daysBetween(lastEdit, today);

      if (daysSinceEdit > threshold) {
        issues.push({
          id: 'no-review-schedule',
          severity: 'info',
          daysSinceEdit,
          lastEdited: frontmatter.lastEdited,
          threshold,
          description: `No reviewBy date; last edited ${daysSinceEdit} days ago (threshold: ${threshold})`,
          suggestion: formatSuggestedReviewDate(today, 30),
        });
      }
    }
  }

  // Check 3: Dependencies updated more recently
  if (frontmatter.contentDependencies && frontmatter.lastEdited) {
    const thisDate: Date | null = parseDate(frontmatter.lastEdited);

    for (const depId of frontmatter.contentDependencies) {
      const depDate: Date | null | undefined = entityDateMap[depId];

      if (depDate && thisDate && depDate > thisDate) {
        const daysBehindVal: number = daysBetween(thisDate, depDate);
        issues.push({
          id: 'dependency-updated',
          severity: 'warning',
          dependencyId: depId,
          daysBehind: daysBehindVal,
          dependencyDate: formatDate(depDate),
          thisDate: frontmatter.lastEdited,
          description: `Dependency "${depId}" was updated ${daysBehindVal} days after this page`,
        });
      }
    }
  }

  return issues;
}

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Format a suggested review date
 */
function formatSuggestedReviewDate(today: Date, daysFromNow: number): string {
  const reviewDate = new Date(today);
  reviewDate.setDate(reviewDate.getDate() + daysFromNow);
  return `reviewBy: "${formatDate(reviewDate)}"`;
}

/**
 * Run the staleness check.
 * Returns a ValidatorResult for use by the orchestrator.
 */
export function runCheck(options?: StalenessCheckOptions): ValidatorResult {
  const CI_MODE = options?.ci ?? false;
  const colors: Colors = getColors(CI_MODE);

  const today = new Date();
  const files: string[] = findMdxFiles(CONTENT_DIR);

  // Build entity date map for dependency checking
  const entityDateMap: EntityDateMap = buildEntityDateMap(files);

  const allIssues: FileWithIssues[] = [];
  let urgentCount = 0;  // Past review by >30 days or dependency updated
  let infoCount = 0;

  // Track stats
  const stats: StalenessStats = {
    totalFiles: 0,
    withReviewBy: 0,
    withLastEdited: 0,
    withDependencies: 0,
  };

  if (!CI_MODE) {
    console.log(`${colors.blue}Checking ${files.length} files for staleness...${colors.reset}\n`);
  }

  for (const file of files) {
    // Skip style guide and index pages
    if (file.includes('/style-guides/') || file.endsWith('index.mdx') || file.endsWith('index.md')) {
      continue;
    }

    try {
      const content: string = readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content) as Frontmatter;

      // Skip non-evergreen pages (reports, blog posts — point-in-time content)
      if (frontmatter.evergreen === false) continue;

      stats.totalFiles++;
      const contentType: string = getContentType(file) || 'default';

      // Update stats
      if (frontmatter.reviewBy) stats.withReviewBy++;
      if (frontmatter.lastEdited) stats.withLastEdited++;
      if (((frontmatter.contentDependencies as string[] | undefined)?.length ?? 0) > 0) stats.withDependencies++;

      const issues: StalenessIssue[] = checkStaleness(file, frontmatter, contentType, entityDateMap, today);

      if (issues.length > 0) {
        allIssues.push({ file, issues, contentType });

        for (const issue of issues) {
          if (issue.severity === 'warning') urgentCount++;
          else infoCount++;
        }
      }
    } catch {
      // Skip files that can't be processed
    }
  }

  // Sort by urgency (warnings first, then by days past)
  allIssues.sort((a: FileWithIssues, b: FileWithIssues) => {
    const aMax: number = Math.max(...a.issues.map((i: StalenessIssue) => i.daysPast || i.daysBehind || 0));
    const bMax: number = Math.max(...b.issues.map((i: StalenessIssue) => i.daysPast || i.daysBehind || 0));
    const aHasWarning: boolean = a.issues.some((i: StalenessIssue) => i.severity === 'warning');
    const bHasWarning: boolean = b.issues.some((i: StalenessIssue) => i.severity === 'warning');
    if (aHasWarning !== bHasWarning) return bHasWarning ? 1 : -1;
    return bMax - aMax;
  });

  if (CI_MODE) {
    console.log(JSON.stringify({
      timestamp: today.toISOString(),
      stats,
      urgentCount,
      infoCount,
      issues: allIssues,
    }, null, 2));
  } else {
    console.log(`${colors.bold}📊 Staleness Statistics${colors.reset}`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`  Total files: ${stats.totalFiles}`);
    console.log(`  With reviewBy: ${stats.withReviewBy} (${Math.round(stats.withReviewBy/stats.totalFiles*100)}%)`);
    console.log(`  With lastEdited: ${stats.withLastEdited} (${Math.round(stats.withLastEdited/stats.totalFiles*100)}%)`);
    console.log(`  With dependencies: ${stats.withDependencies}`);
    console.log();

    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ No stale content detected${colors.reset}\n`);
    } else {
      console.log(`${colors.bold}📅 Staleness Report${colors.reset}`);
      console.log(`${'─'.repeat(40)}\n`);

      // Show urgent issues first
      const urgent: FileWithIssues[] = allIssues.filter((a: FileWithIssues) => a.issues.some((i: StalenessIssue) => i.severity === 'warning'));
      const other: FileWithIssues[] = allIssues.filter((a: FileWithIssues) => !a.issues.some((i: StalenessIssue) => i.severity === 'warning'));

      if (urgent.length > 0) {
        console.log(`${colors.yellow}${colors.bold}⚠️  Needs Attention (${urgent.length} pages)${colors.reset}\n`);

        for (const { file, issues } of urgent.slice(0, 20)) {
          const relPath: string = formatPath(file);
          console.log(`${colors.bold}${relPath}${colors.reset}`);

          for (const issue of issues) {
            const icon: string = issue.severity === 'warning' ? `${colors.yellow}⚠` : `${colors.blue}ℹ`;
            console.log(`  ${icon} ${issue.description}${colors.reset}`);
            if (issue.suggestion) {
              console.log(`    ${colors.dim}Add: ${issue.suggestion}${colors.reset}`);
            }
          }
          console.log();
        }

        if (urgent.length > 20) {
          console.log(`  ${colors.dim}...and ${urgent.length - 20} more${colors.reset}\n`);
        }
      }

      if (other.length > 0) {
        console.log(`${colors.blue}ℹ️  Suggestions (${other.length} pages)${colors.reset}\n`);

        for (const { file, issues } of other.slice(0, 10)) {
          const relPath: string = formatPath(file);
          console.log(`  ${colors.dim}${relPath}${colors.reset}`);
          for (const issue of issues) {
            console.log(`    ${colors.dim}${issue.description}${colors.reset}`);
          }
        }

        if (other.length > 10) {
          console.log(`  ${colors.dim}...and ${other.length - 10} more${colors.reset}`);
        }
        console.log();
      }

      console.log(`${'─'.repeat(40)}`);
      console.log(`${colors.bold}Summary:${colors.reset}`);
      if (urgentCount > 0) {
        console.log(`  ${colors.yellow}${urgentCount} page(s) need attention${colors.reset}`);
      }
      if (infoCount > 0) {
        console.log(`  ${colors.blue}${infoCount} suggestion(s)${colors.reset}`);
      }
      console.log();
    }
  }

  // Exit with error only if there are urgent issues (>30 days past review)
  const criticalCount: number = allIssues.filter((a: FileWithIssues) =>
    a.issues.some((i: StalenessIssue) => i.id === 'past-review-date' && (i.daysPast ?? 0) > 30)
  ).length;

  return {
    passed: criticalCount === 0,
    errors: criticalCount,
    warnings: urgentCount - criticalCount,
    infos: infoCount,
  };
}

/**
 * Main function
 */
function main(): void {
  const CI_MODE: boolean = process.argv.includes('--ci') || process.argv.includes('--json');
  const result = runCheck({ ci: CI_MODE });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
