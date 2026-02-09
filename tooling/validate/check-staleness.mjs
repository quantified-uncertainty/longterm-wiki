#!/usr/bin/env node

/**
 * Content Staleness Detection Script
 *
 * Checks for stale content based on:
 * - reviewBy dates in frontmatter (past due)
 * - contentDependencies that have been updated more recently
 * - Time since lastEdited (threshold varies by content type)
 *
 * Usage: node scripts/check-staleness.mjs [--ci] [--json]
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
import { findMdxFiles } from '../lib/file-utils.mjs';
import { parseFrontmatter } from '../lib/mdx-utils.mjs';
import { getColors, formatPath } from '../lib/output.mjs';
import { getContentType, getStalenessThreshold, CONTENT_DIR, DEFAULT_STALENESS_THRESHOLD } from '../lib/content-types.mjs';

const CI_MODE = process.argv.includes('--ci') || process.argv.includes('--json');
const colors = getColors(CI_MODE);

/**
 * Parse a date string (YYYY-MM-DD or YYYY-MM) to Date object
 */
function parseDate(dateStr) {
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
function daysBetween(date1, date2) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((date2 - date1) / msPerDay);
}

/**
 * Build a map of entity IDs to their lastEdited dates
 */
function buildEntityDateMap(files) {
  const map = {};
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const fm = parseFrontmatter(content);
      // Extract entity ID from filename
      const filename = file.split('/').pop().replace(/\.(mdx?|md)$/, '');
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
function checkStaleness(filePath, frontmatter, contentType, entityDateMap, today) {
  const issues = [];

  // Check 1: Past reviewBy date
  if (frontmatter.reviewBy) {
    const reviewDate = parseDate(frontmatter.reviewBy);
    if (reviewDate && reviewDate < today) {
      const daysPast = daysBetween(reviewDate, today);
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
    const lastEdit = parseDate(frontmatter.lastEdited);
    const threshold = getStalenessThreshold(contentType);

    if (lastEdit) {
      const daysSinceEdit = daysBetween(lastEdit, today);

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
    const thisDate = parseDate(frontmatter.lastEdited);

    for (const depId of frontmatter.contentDependencies) {
      const depDate = entityDateMap[depId];

      if (depDate && thisDate && depDate > thisDate) {
        const daysBehind = daysBetween(thisDate, depDate);
        issues.push({
          id: 'dependency-updated',
          severity: 'warning',
          dependencyId: depId,
          daysBehind,
          dependencyDate: formatDate(depDate),
          thisDate: frontmatter.lastEdited,
          description: `Dependency "${depId}" was updated ${daysBehind} days after this page`,
        });
      }
    }
  }

  return issues;
}

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Format a suggested review date
 */
function formatSuggestedReviewDate(today, daysFromNow) {
  const reviewDate = new Date(today);
  reviewDate.setDate(reviewDate.getDate() + daysFromNow);
  return `reviewBy: "${formatDate(reviewDate)}"`;
}

/**
 * Main function
 */
function main() {
  const today = new Date();
  const files = findMdxFiles(CONTENT_DIR);

  // Build entity date map for dependency checking
  const entityDateMap = buildEntityDateMap(files);

  const allIssues = [];
  let urgentCount = 0;  // Past review by >30 days or dependency updated
  let infoCount = 0;

  // Track stats
  const stats = {
    totalFiles: files.length,
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
      const content = readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const contentType = getContentType(file) || 'default';

      // Update stats
      if (frontmatter.reviewBy) stats.withReviewBy++;
      if (frontmatter.lastEdited) stats.withLastEdited++;
      if (frontmatter.contentDependencies?.length > 0) stats.withDependencies++;

      const issues = checkStaleness(file, frontmatter, contentType, entityDateMap, today);

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
  allIssues.sort((a, b) => {
    const aMax = Math.max(...a.issues.map(i => i.daysPast || i.daysBehind || 0));
    const bMax = Math.max(...b.issues.map(i => i.daysPast || i.daysBehind || 0));
    const aHasWarning = a.issues.some(i => i.severity === 'warning');
    const bHasWarning = b.issues.some(i => i.severity === 'warning');
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
      const urgent = allIssues.filter(a => a.issues.some(i => i.severity === 'warning'));
      const other = allIssues.filter(a => !a.issues.some(i => i.severity === 'warning'));

      if (urgent.length > 0) {
        console.log(`${colors.yellow}${colors.bold}⚠️  Needs Attention (${urgent.length} pages)${colors.reset}\n`);

        for (const { file, issues } of urgent.slice(0, 20)) {
          const relPath = formatPath(file);
          console.log(`${colors.bold}${relPath}${colors.reset}`);

          for (const issue of issues) {
            const icon = issue.severity === 'warning' ? `${colors.yellow}⚠` : `${colors.blue}ℹ`;
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
          const relPath = formatPath(file);
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
  const criticalCount = allIssues.filter(a =>
    a.issues.some(i => i.id === 'past-review-date' && i.daysPast > 30)
  ).length;

  process.exit(criticalCount > 0 ? 1 : 0);
}

main();
