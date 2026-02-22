#!/usr/bin/env node

/**
 * Session Log Validator
 *
 * Validates `.claude/sessions/*.yaml` files against a Zod schema.
 * Also warns about stray `.md` files (legacy format; sessions are now stored in the wiki-server DB).
 *
 * Schema fields:
 *   date: YYYY-MM-DD (required)
 *   branch: string (required)
 *   title: string (required)
 *   summary: string (required)
 *   model: string — e.g. opus-4-6, sonnet-4 (recommended)
 *   duration: string — e.g. ~45min, ~2h (recommended)
 *   cost: string — e.g. ~$5 (optional)
 *   pages: string[] — page slugs (optional, omit for infrastructure sessions)
 *   pr: number | string — PR number or #NNN (optional)
 *   issues: string[] (optional)
 *   learnings: string[] (optional)
 *   recommendations: string[] | object[] (optional)
 *
 * Usage:
 *   npx tsx crux/validate/validate-session-logs.ts
 *   npx tsx crux/validate/validate-session-logs.ts --ci
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const colors = getColors(CI_MODE);

const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');
const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})_(.+)\.yaml$/;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_MODELS = [
  'opus-4-6', 'opus-4', 'sonnet-4-6', 'sonnet-4-5', 'sonnet-4',
  'haiku-4-5', 'haiku-4', 'sonnet-3-5',
];

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const PageIdSchema = z.string().regex(PAGE_ID_RE, {
  message: 'Page ID must be a lowercase slug (e.g. "ai-risks")',
});

const PrSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^#\d+$|\/pull\/\d+/, {
    message: 'PR must be an integer, "#NNN", or a GitHub pull URL',
  }),
]).optional();

const RecommendationSchema = z.union([
  z.string(),
  z.object({
    area: z.string(),
    suggestion: z.string(),
  }),
]);

const ChecksSchema = z.object({
  initialized: z.boolean(),
  type: z.string().optional(),
  initiated_at: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
  completed: z.number().int().nonnegative().optional(),
  na: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  items: z.array(z.string()).optional(),
});

export const SessionLogSchema = z.object({
  date: z.string().regex(DATE_RE, { message: 'date must be YYYY-MM-DD' }),
  branch: z.string().min(1, { message: 'branch is required' }),
  title: z.string().min(1, { message: 'title is required' }),
  summary: z.string().min(1, { message: 'summary is required' }),
  model: z.string().optional(),
  duration: z.string().optional(),
  cost: z.string().optional(),
  pages: z.array(PageIdSchema).optional().default([]),
  pr: PrSchema,
  issues: z.array(z.string()).optional(),
  learnings: z.array(z.string()).optional(),
  recommendations: z.array(RecommendationSchema).optional(),
  checks: ChecksSchema.optional(),
}).strict();

export type SessionLogEntry = z.infer<typeof SessionLogSchema>;

// ---------------------------------------------------------------------------
// Validation issue types
// ---------------------------------------------------------------------------

interface ValidationIssue {
  file: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

function validate(): { passed: boolean; errors: number; warnings: number } {
  const issues: ValidationIssue[] = [];

  if (!existsSync(SESSIONS_DIR)) {
    console.log(`${colors.dim}No local sessions directory — session logs are stored in the wiki-server DB${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  const allFiles = readdirSync(SESSIONS_DIR).sort();
  const yamlFiles = allFiles.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const mdFiles = allFiles.filter(f => f.endsWith('.md'));

  if (yamlFiles.length === 0 && mdFiles.length === 0) {
    console.log(`${colors.dim}No local session log files — session logs are stored in the wiki-server DB${colors.reset}`);
    return { passed: true, errors: 0, warnings: 0 };
  }

  // Warn about stray .md files
  for (const file of mdFiles) {
    issues.push({
      file,
      field: 'format',
      message: 'Legacy Markdown format — sessions are now stored in the wiki-server DB; this .md file can be deleted',
      severity: 'warning',
    });
  }

  // Validate each YAML file
  for (const file of yamlFiles) {
    const filePath = join(SESSIONS_DIR, file);
    const content = readFileSync(filePath, 'utf-8');

    // 1. Validate filename format
    const filenameMatch = file.match(FILENAME_RE);
    if (!filenameMatch) {
      issues.push({
        file,
        field: 'filename',
        message: `Invalid filename format (expected YYYY-MM-DD_<branch-suffix>.yaml)`,
        severity: 'warning',
      });
    }

    // 2. Parse YAML
    let data: unknown;
    try {
      data = parseYaml(content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({ file, field: 'yaml', message: `YAML parse error: ${message}`, severity: 'error' });
      continue;
    }

    // 3. Validate against Zod schema
    const result = SessionLogSchema.safeParse(data);
    if (!result.success) {
      for (const zodIssue of result.error.issues) {
        const field = zodIssue.path.length > 0 ? zodIssue.path.join('.') : 'root';
        // Treat missing required fields as errors; other issues as warnings
        const isRequired = zodIssue.code === 'invalid_type' && zodIssue.received === 'undefined';
        issues.push({
          file,
          field,
          message: zodIssue.message,
          severity: isRequired ? 'error' : 'warning',
        });
      }
      if (!result.success) continue;
    }

    const entry = result.data;

    // 4. Cross-check filename date vs entry date
    if (filenameMatch && filenameMatch[1] !== entry.date) {
      issues.push({
        file,
        field: 'date',
        message: `Filename date (${filenameMatch[1]}) doesn't match entry date (${entry.date})`,
        severity: 'warning',
      });
    }

    // 5. Recommended field: model
    if (!entry.model) {
      issues.push({
        file,
        field: 'model',
        message: 'Missing recommended field "model" (e.g., opus-4-6, sonnet-4)',
        severity: 'warning',
      });
    } else if (!KNOWN_MODELS.includes(entry.model)) {
      issues.push({
        file,
        field: 'model',
        message: `Unknown model "${entry.model}" (known: ${KNOWN_MODELS.join(', ')})`,
        severity: 'warning',
      });
    }

    // 6. Recommended field: duration
    if (!entry.duration) {
      issues.push({
        file,
        field: 'duration',
        message: 'Missing recommended field "duration" (e.g., ~15min, ~45min)',
        severity: 'warning',
      });
    }

    // 7. Recommended field: checks (checklist compliance audit trail)
    if (!entry.checks) {
      issues.push({
        file,
        field: 'checks',
        message: 'Missing checks: field — run `crux agent-checklist snapshot` before creating session log',
        severity: 'warning',
      });
    } else if (!entry.checks.initialized) {
      issues.push({
        file,
        field: 'checks.initialized',
        message: 'Checklist was not initialized at session start (checks.initialized: false)',
        severity: 'warning',
      });
    }
  }

  // Output
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  const totalFiles = yamlFiles.length + mdFiles.length;

  if (CI_MODE) {
    console.log(JSON.stringify(
      { files: totalFiles, yamlFiles: yamlFiles.length, mdFiles: mdFiles.length, errors: errors.length, warnings: warnings.length, issues },
      null,
      2,
    ));
  } else {
    if (issues.length === 0) {
      console.log(`${colors.green}All ${yamlFiles.length} session log files are valid${colors.reset}`);
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
      console.log(`  ${yamlFiles.length} YAML files, ${mdFiles.length} legacy MD files checked`);
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
