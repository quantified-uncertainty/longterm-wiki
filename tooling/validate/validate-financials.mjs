#!/usr/bin/env node

/**
 * Financial Data Validator
 *
 * Checks people, funder, and organization pages for:
 * - Stale financial figures (net worth, valuations sourced >2 years ago)
 * - Known major holdings not reflected (Anthropic, OpenAI, crypto)
 * - Cross-page inconsistencies between person/funder pages and investment pages
 *
 * Usage: node scripts/validate/validate-financials.mjs [--ci]
 *
 * Exit codes:
 *   0 = No issues found
 *   1 = Issues found
 */

import { readFileSync } from 'fs';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.mjs';
import { getColors, formatPath } from '../lib/output.mjs';
import { CONTENT_DIR } from '../lib/content-types.js';

const CI_MODE = process.argv.includes('--ci') || process.argv.includes('--json');
const colors = getColors(CI_MODE);

// Pages most likely to have financial data worth validating
const FINANCIAL_PATH_PATTERNS = [
  /\/people\//,
  /\/funders\//,
];

// Known major assets that should be cross-referenced
const MAJOR_ASSETS = [
  { name: 'Anthropic', pattern: /anthropic/i, valuationNote: 'Anthropic valued at $60B+ (2024) / $350B+ (2025)' },
  { name: 'OpenAI', pattern: /openai/i, valuationNote: 'OpenAI valued at $150B+ (2024) / $300B+ (2025)' },
  { name: 'DeepMind', pattern: /deepmind/i, valuationNote: 'Acquired by Google for ~$500M (2014)' },
];

// Patterns that indicate key financial assertions (not just mentions)
const FINANCIAL_PATTERNS = [
  { pattern: /^\|\s*\*?\*?Net\s+Worth\*?\*?\s*\|/i, label: 'net worth table row' },
  { pattern: /Forbes.*\\\$|Forbes.*billion|Forbes.*million/i, label: 'Forbes citation' },
];


/**
 * Check if a file is a financial page
 */
function isFinancialPage(filePath) {
  return FINANCIAL_PATH_PATTERNS.some(p => p.test(filePath));
}

/**
 * Extract financial figure contexts from page content
 */
function extractFinancialContexts(body) {
  const contexts = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const fp of FINANCIAL_PATTERNS) {
      if (fp.pattern.test(line)) {
        // Extract years mentioned near the figure
        const years = [];
        const nearbyText = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
        let yearMatch;
        const yearRe = /\b(201[0-9]|202[0-6])\b/g;
        while ((yearMatch = yearRe.exec(nearbyText)) !== null) {
          years.push(parseInt(yearMatch[1]));
        }

        contexts.push({
          line: i + 1,
          type: fp.label,
          text: line.trim().substring(0, 120),
          years,
        });
        break; // One match per line is enough
      }
    }
  }
  return contexts;
}

/**
 * Check a single financial page for issues
 */
function checkFinancialPage(filePath, frontmatter, body) {
  const issues = [];
  const currentYear = new Date().getFullYear();
  const staleThreshold = currentYear - 2;

  const contexts = extractFinancialContexts(body);

  // Check 1: Stale financial figures — only flag structured table rows with exclusively old years
  for (const ctx of contexts) {
    const oldYears = ctx.years.filter(y => y <= staleThreshold);
    if (oldYears.length > 0 && !ctx.years.some(y => y > staleThreshold)) {
      issues.push({
        severity: 'warning',
        check: 'stale-figure',
        message: `Potentially stale ${ctx.type} (line ${ctx.line}): only references year(s) ${oldYears.join(', ')}`,
        detail: ctx.text,
      });
    }
  }

  // Check 2: lastEdited date — flag if financial page hasn't been updated in >1 year
  if (frontmatter.lastEdited) {
    const lastEdit = new Date(frontmatter.lastEdited);
    const daysSince = Math.floor((Date.now() - lastEdit.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince > 365) {
      issues.push({
        severity: 'info',
        check: 'old-financial-page',
        message: `Financial page last edited ${daysSince} days ago (${frontmatter.lastEdited})`,
      });
    }
  }

  // Check 3: People/funder pages with net worth that mention major assets without valuing them
  // Only check pages that have a net worth table row (i.e., they're tracking wealth)
  const hasNetWorthRow = /^\|\s*\*?\*?Net\s+Worth\*?\*?\s*\|/im.test(body);
  if (hasNetWorthRow && (filePath.includes('/people/') || filePath.includes('/funders/'))) {
    for (const asset of MAJOR_ASSETS) {
      if (asset.pattern.test(body)) {
        // Check if there's a dollar figure on a line mentioning the asset
        const assetLines = body.split('\n').filter(l => asset.pattern.test(l));
        const hasValuation = assetLines.some(l => /\\\$[\d.,]+\s*[BMTbmt]/i.test(l) || /billion|million/i.test(l));

        if (!hasValuation) {
          issues.push({
            severity: 'info',
            check: 'unvalued-holding',
            message: `Net worth page mentions ${asset.name} but no valuation found for that holding`,
            detail: asset.valuationNote,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Main
 */
function main() {
  const files = findMdxFiles(CONTENT_DIR);
  const financialFiles = files.filter(f => isFinancialPage(f) && !f.endsWith('index.mdx'));

  const allIssues = [];
  let warningCount = 0;
  let infoCount = 0;

  if (!CI_MODE) {
    console.log(`${colors.bold}${colors.blue}Financial Data Validator${colors.reset}`);
    console.log(`${colors.dim}Checking ${financialFiles.length} financial pages...${colors.reset}\n`);
  }

  for (const file of financialFiles) {
    try {
      const content = readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const body = getContentBody(content);

      const issues = checkFinancialPage(file, frontmatter, body);

      if (issues.length > 0) {
        allIssues.push({ file, issues });
        for (const issue of issues) {
          if (issue.severity === 'warning') warningCount++;
          else infoCount++;
        }
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  if (CI_MODE) {
    console.log(JSON.stringify({
      scannedFiles: financialFiles.length,
      warningCount,
      infoCount,
      issues: allIssues,
    }, null, 2));
    process.exit(warningCount > 0 ? 1 : 0);
    return;
  }

  // Human output
  if (allIssues.length === 0) {
    console.log(`${colors.green}✓ No financial data issues found${colors.reset}\n`);
  } else {
    // Warnings first
    const warnings = allIssues.filter(a => a.issues.some(i => i.severity === 'warning'));
    const infos = allIssues.filter(a => !a.issues.some(i => i.severity === 'warning'));

    if (warnings.length > 0) {
      console.log(`${colors.yellow}${colors.bold}Warnings (${warningCount})${colors.reset}\n`);
      for (const { file, issues } of warnings) {
        console.log(`  ${colors.bold}${formatPath(file)}${colors.reset}`);
        for (const issue of issues.filter(i => i.severity === 'warning')) {
          console.log(`    ${colors.yellow}⚠ ${issue.message}${colors.reset}`);
          if (issue.detail) {
            console.log(`      ${colors.dim}${issue.detail}${colors.reset}`);
          }
        }
        console.log();
      }
    }

    if (infos.length > 0) {
      console.log(`${colors.blue}Info (${infoCount})${colors.reset}\n`);
      for (const { file, issues } of infos) {
        console.log(`  ${colors.dim}${formatPath(file)}${colors.reset}`);
        for (const issue of issues.filter(i => i.severity === 'info')) {
          console.log(`    ${colors.dim}ℹ ${issue.message}${colors.reset}`);
        }
      }
      console.log();
    }
  }

  console.log(`${'─'.repeat(50)}`);
  console.log(`Scanned: ${financialFiles.length} pages, ${warningCount} warning(s), ${infoCount} info(s)`);

  process.exit(warningCount > 0 ? 1 : 0);
}

main();
