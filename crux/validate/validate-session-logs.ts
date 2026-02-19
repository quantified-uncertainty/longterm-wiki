#!/usr/bin/env node

/**
 * Session Log Validator
 *
 * Validates `.claude/sessions/*.md` files for format compliance.
 *
 * Checks:
 * - Heading format: ## YYYY-MM-DD | branch-name | title
 * - Required field: **What was done:**
 * - Recommended fields: **Model:**, **Duration:**
 * - Optional field format: **Pages:** (comma-separated slugs), **PR:** (#NNN or URL)
 * - File naming: YYYY-MM-DD_<branch-suffix>.md
 * - Date consistency: filename date matches heading date
 *
 * Usage:
 *   npx tsx crux/validate/validate-session-logs.ts
 *   npx tsx crux/validate/validate-session-logs.ts --ci
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const colors = getColors(CI_MODE);

const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');

const HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)$/;
const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})_(.+)\.md$/;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

interface ValidationIssue {
  file: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

function validate(): { passed: boolean; errors: number; warnings: number } {
  const issues: ValidationIssue[] = [];

  if (!existsSync(SESSIONS_DIR)) {
    console.log(`${colors.dim}No sessions directory found — skipping${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md')).sort();

  if (files.length === 0) {
    console.log(`${colors.dim}No session log files found — skipping${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  for (const file of files) {
    const content = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
    const lines = content.split('\n');

    // 1. Validate filename format
    const filenameMatch = file.match(FILENAME_RE);
    if (!filenameMatch) {
      issues.push({
        file,
        field: 'filename',
        message: `Invalid filename format (expected YYYY-MM-DD_<branch-suffix>.md)`,
        severity: 'warning',
      });
    }

    // 2. Validate heading line
    const headingLine = lines[0];
    const headingMatch = headingLine?.match(HEADING_RE);

    if (!headingMatch) {
      issues.push({
        file,
        field: 'heading',
        message: 'Missing or invalid heading (expected: ## YYYY-MM-DD | branch-name | title)',
        severity: 'error',
      });
      // Can't validate further without a heading
      continue;
    }

    const headingDate = headingMatch[1];
    const headingBranch = headingMatch[2].trim();

    // 3. Cross-check filename date vs heading date
    if (filenameMatch && filenameMatch[1] !== headingDate) {
      issues.push({
        file,
        field: 'date',
        message: `Filename date (${filenameMatch[1]}) doesn't match heading date (${headingDate})`,
        severity: 'warning',
      });
    }

    // 4. Validate body fields
    const body = lines.slice(1).join('\n');

    // Required: What was done
    if (!/\*\*What was done:\*\*/.test(body)) {
      issues.push({
        file,
        field: 'What was done',
        message: 'Missing required field "**What was done:**"',
        severity: 'error',
      });
    }

    // Recommended: Model (always required per rules)
    if (!/\*\*Model:\*\*/.test(body)) {
      issues.push({
        file,
        field: 'Model',
        message: 'Missing recommended field "**Model:**" (e.g., opus-4-6, sonnet-4)',
        severity: 'warning',
      });
    }

    // Recommended: Duration (always required per rules)
    if (!/\*\*Duration:\*\*/.test(body)) {
      issues.push({
        file,
        field: 'Duration',
        message: 'Missing recommended field "**Duration:**" (e.g., ~15min, ~45min)',
        severity: 'warning',
      });
    }

    // Validate Pages field format if present
    const pagesMatch = body.match(/\*\*Pages:\*\*\s*(.+?)(?:\n\n|\n\*\*|$)/s);
    if (pagesMatch) {
      const pagesValue = pagesMatch[1].trim();
      // Skip validation for explicit "none" markers
      if (pagesValue && !/^\(.*\)$/.test(pagesValue) && pagesValue.toLowerCase() !== 'none') {
        const pageIds = pagesValue.split(',').map(id => id.trim()).filter(Boolean);
        for (const pageId of pageIds) {
          if (!PAGE_ID_RE.test(pageId)) {
            issues.push({
              file,
              field: 'Pages',
              message: `Invalid page ID "${pageId}" (expected lowercase slug like "ai-risks")`,
              severity: 'warning',
            });
          }
        }
      }
    }

    // Validate PR field format if present
    const prMatch = body.match(/\*\*PR:\*\*\s*(.+?)(?:\n\n|\n\*\*|$)/s);
    if (prMatch) {
      const prValue = prMatch[1].trim();
      const isValidPR = /^#\d+$/.test(prValue) || /\/pull\/\d+/.test(prValue);
      if (!isValidPR) {
        issues.push({
          file,
          field: 'PR',
          message: `Invalid PR format "${prValue}" (expected "#123" or GitHub URL)`,
          severity: 'warning',
        });
      }
    }

    // Validate Model field value if present
    const modelMatch = body.match(/\*\*Model:\*\*\s*(.+?)(?:\n\n|\n\*\*|$)/s);
    if (modelMatch) {
      const modelValue = modelMatch[1].trim();
      const knownModels = ['opus-4-6', 'opus-4', 'sonnet-4-6', 'sonnet-4-5', 'sonnet-4', 'haiku-4-5', 'haiku-4', 'sonnet-3-5'];
      if (!knownModels.includes(modelValue)) {
        issues.push({
          file,
          field: 'Model',
          message: `Unknown model "${modelValue}" (known: ${knownModels.join(', ')})`,
          severity: 'warning',
        });
      }
    }
  }

  // Output
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (CI_MODE) {
    console.log(JSON.stringify({ files: files.length, errors: errors.length, warnings: warnings.length, issues }, null, 2));
  } else {
    if (issues.length === 0) {
      console.log(`${colors.green}All ${files.length} session log files are valid${colors.reset}`);
    } else {
      // Group issues by file for cleaner output
      const byFile = new Map<string, ValidationIssue[]>();
      for (const issue of issues) {
        if (!byFile.has(issue.file)) byFile.set(issue.file, []);
        byFile.get(issue.file)!.push(issue);
      }

      for (const [file, fileIssues] of byFile) {
        console.log(`\n  ${colors.bold}${file}${colors.reset}`);
        for (const issue of fileIssues) {
          const icon = issue.severity === 'error' ? `${colors.red}E` : `${colors.yellow}W`;
          console.log(`    ${icon}${colors.reset} ${issue.field}: ${issue.message}`);
        }
      }

      console.log();
      console.log(`  ${files.length} files checked`);
      if (errors.length > 0) console.log(`  ${colors.red}${errors.length} error(s)${colors.reset}`);
      if (warnings.length > 0) console.log(`  ${colors.yellow}${warnings.length} warning(s)${colors.reset}`);
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
