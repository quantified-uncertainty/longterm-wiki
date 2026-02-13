#!/usr/bin/env node

/**
 * Edit Log Validator
 *
 * Validates YAML files in data/edit-logs/ for schema correctness.
 * Checks that entries have required fields, valid enum values,
 * and that page IDs correspond to existing pages.
 *
 * Usage:
 *   npx tsx crux/validate/validate-edit-logs.ts
 *   npx tsx crux/validate/validate-edit-logs.ts --ci
 */

import { readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { readEditLog } from '../lib/edit-log.ts';
import { findMdxFiles } from '../lib/file-utils.ts';

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const colors = getColors(CI_MODE);

const VALID_TOOLS = new Set(['crux-create', 'crux-improve', 'crux-grade', 'crux-fix', 'claude-code', 'manual', 'bulk-script']);
const VALID_AGENCIES = new Set(['human', 'ai-directed', 'automated']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EDIT_LOGS_DIR = join(PROJECT_ROOT, 'data/edit-logs');

interface ValidationIssue {
  file: string;
  index: number;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

function validate(): { passed: boolean; errors: number; warnings: number } {
  const issues: ValidationIssue[] = [];

  if (!existsSync(EDIT_LOGS_DIR)) {
    console.log(`${colors.dim}No edit-logs directory found — skipping${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  const files = readdirSync(EDIT_LOGS_DIR).filter(f => f.endsWith('.yaml'));

  if (files.length === 0) {
    console.log(`${colors.dim}No edit log files found — skipping${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  // Build set of known page slugs
  const mdxFiles = findMdxFiles(CONTENT_DIR);
  const knownSlugs = new Set(
    mdxFiles.map(f => {
      const rel = relative(CONTENT_DIR, f);
      return rel.replace(/\.mdx?$/, '').replace(/\/index$/, '').split('/').pop()!;
    }),
  );

  for (const file of files) {
    const pageId = file.replace(/\.yaml$/, '');
    const entries = readEditLog(pageId);

    // Check if page exists
    if (!knownSlugs.has(pageId)) {
      issues.push({
        file,
        index: -1,
        field: 'pageId',
        message: `Edit log for "${pageId}" has no matching MDX page`,
        severity: 'warning',
      });
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Required: date
      if (!entry.date) {
        issues.push({ file, index: i, field: 'date', message: 'Missing required field "date"', severity: 'error' });
      } else if (!DATE_RE.test(entry.date)) {
        issues.push({ file, index: i, field: 'date', message: `Invalid date format "${entry.date}" (expected YYYY-MM-DD)`, severity: 'error' });
      }

      // Required: tool
      if (!entry.tool) {
        issues.push({ file, index: i, field: 'tool', message: 'Missing required field "tool"', severity: 'error' });
      } else if (!VALID_TOOLS.has(entry.tool)) {
        issues.push({ file, index: i, field: 'tool', message: `Invalid tool "${entry.tool}" (expected: ${[...VALID_TOOLS].join(', ')})`, severity: 'error' });
      }

      // Required: agency
      if (!entry.agency) {
        issues.push({ file, index: i, field: 'agency', message: 'Missing required field "agency"', severity: 'error' });
      } else if (!VALID_AGENCIES.has(entry.agency)) {
        issues.push({ file, index: i, field: 'agency', message: `Invalid agency "${entry.agency}" (expected: ${[...VALID_AGENCIES].join(', ')})`, severity: 'error' });
      }
    }
  }

  // Output
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (CI_MODE) {
    console.log(JSON.stringify({ errors: errors.length, warnings: warnings.length, issues }, null, 2));
  } else {
    if (issues.length === 0) {
      console.log(`${colors.green}All ${files.length} edit log files are valid${colors.reset}`);
    } else {
      for (const issue of issues) {
        const icon = issue.severity === 'error' ? `${colors.red}E` : `${colors.yellow}W`;
        const loc = issue.index >= 0 ? ` entry[${issue.index}].${issue.field}` : '';
        console.log(`  ${icon}${colors.reset} ${issue.file}${loc}: ${issue.message}`);
      }
      console.log();
      if (errors.length > 0) console.log(`${colors.red}${errors.length} error(s)${colors.reset}`);
      if (warnings.length > 0) console.log(`${colors.yellow}${warnings.length} warning(s)${colors.reset}`);
    }
  }

  return { passed: errors.length === 0, errors: errors.length, warnings: warnings.length };
}

function main(): void {
  const result = validate();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { validate as runCheck };
