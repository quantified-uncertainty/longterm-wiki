#!/usr/bin/env node

/**
 * Detect Drizzle schema drift: schema.ts changed without a new migration.
 *
 * ## Background
 *
 * PR #1570 revealed a migration journal desync: migration 0052 was recorded in
 * the Drizzle journal as complete but its SQL never actually ran on production.
 * The core problem: there is no CI check that prevents schema.ts from diverging
 * from the migration files.
 *
 * ## What this check does
 *
 * In PR context (BASE_SHA/HEAD_SHA env vars set), this script:
 *
 * 1. Checks whether `apps/wiki-server/src/schema.ts` changed in this PR.
 * 2. If it did, checks whether any new migration SQL file was added in `apps/wiki-server/drizzle/`.
 * 3. If schema changed but no new migration exists, emits `::warning::` (advisory, not blocking).
 *
 * Outside of PR context (e.g., local runs, main branch CI), it runs `drizzle-kit check`
 * which compares schema.ts against the migration journal snapshots (meta/*.json)
 * without requiring a live database connection.
 *
 * ## Why warning-only
 *
 * Some schema.ts changes don't need migrations:
 * - Type-only changes (TypeScript types, Zod schemas)
 * - Index definitions when the index already exists
 * - Comments, formatting, refactors
 *
 * This check is a lightweight heuristic that catches the common case
 * (forgot to run `drizzle-kit generate`) without blocking merge for legitimate
 * non-structural changes.
 *
 * ## Usage
 *
 * In CI (pull_request events):
 *   BASE_SHA=<base> HEAD_SHA=<head> npx tsx crux/validate/validate-schema-drift.ts
 *
 * Locally (uses drizzle-kit check against journal snapshots):
 *   npx tsx crux/validate/validate-schema-drift.ts
 *
 * Related: issues #1686, #1570
 */

import { execSync, spawnSync } from 'child_process';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { join } from 'path';

const SCHEMA_PATH = 'apps/wiki-server/src/schema.ts';
const WIKI_SERVER_DIR = join(PROJECT_ROOT, 'apps/wiki-server');

interface CheckResult {
  passed: boolean;
  warnings: number;
  errors: number;
  details: string[];
}

function getChangedFiles(baseSha: string, headSha: string): string[] | null {
  try {
    const output = execSync(`git diff --name-only ${baseSha}...${headSha}`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`git diff failed (shallow clone or missing commits?): ${msg}`);
    return null; // null = git failure, distinguish from [] = no files changed
  }
}

function getAddedFiles(baseSha: string, headSha: string): string[] {
  try {
    // --diff-filter=A shows only added files
    const output = execSync(`git diff --diff-filter=A --name-only ${baseSha}...${headSha}`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runPrDriftCheck(baseSha: string, headSha: string, c: ReturnType<typeof getColors>): CheckResult {
  const details: string[] = [];
  let warnings = 0;

  console.log(`${c.blue}Checking Drizzle schema drift (PR mode: ${baseSha.slice(0, 8)}...${headSha.slice(0, 8)})...${c.reset}\n`);

  const changedFiles = getChangedFiles(baseSha, headSha);
  if (changedFiles === null) {
    const msg = `Could not determine changed files via git diff (shallow clone without sufficient history?). ` +
      `Skipping schema drift check — check CI logs and ensure the checkout has enough history.`;
    console.log(`${c.yellow}Warning: ${msg}${c.reset}`);
    console.log(`::warning::${msg}`);
    return { passed: true, warnings: 1, errors: 0, details: [msg] };
  }

  const addedFiles = getAddedFiles(baseSha, headSha);

  const schemaChanged = changedFiles.includes(SCHEMA_PATH);
  const newMigrations = addedFiles.filter(f =>
    f.startsWith('apps/wiki-server/drizzle/') && f.endsWith('.sql')
  );
  const migrationChanged = newMigrations.length > 0 ||
    changedFiles.some(f => f.startsWith('apps/wiki-server/drizzle/') && f.endsWith('.sql'));

  if (!schemaChanged) {
    console.log(`${c.green}schema.ts not modified in this PR — no drift check needed${c.reset}`);
    return { passed: true, warnings: 0, errors: 0, details: [] };
  }

  console.log(`${c.yellow}schema.ts was modified in this PR${c.reset}`);

  if (migrationChanged) {
    if (newMigrations.length > 0) {
      console.log(`${c.green}New migration(s) found — schema change is covered:${c.reset}`);
      for (const m of newMigrations) {
        console.log(`  ${c.green}+ ${m}${c.reset}`);
      }
    } else {
      console.log(`${c.green}Existing migration files were modified alongside schema.ts${c.reset}`);
    }
    return { passed: true, warnings: 0, errors: 0, details: [] };
  }

  // Schema changed but no migration was added or modified
  const msg = [
    'schema.ts changed but no Drizzle migration was added or modified.',
    'If you added/changed table columns or constraints, run: drizzle-kit generate',
    'in apps/wiki-server/ to create the migration.',
    'If this is a type-only or non-structural change (comments, TS types), this warning can be ignored.',
    'Reference: issue #1686, PR #1570 (migration 0052 journal desync)',
  ].join(' ');

  console.log(`\n${c.yellow}${msg}${c.reset}\n`);
  // Emit GitHub Actions warning annotation
  console.log(`::warning::${msg}`);

  details.push(msg);
  warnings++;

  return { passed: true, warnings, errors: 0, details };
}

function runDrizzleKitCheck(c: ReturnType<typeof getColors>): CheckResult {
  const details: string[] = [];
  let warnings = 0;

  console.log(`${c.blue}Checking Drizzle schema vs migration journal (drizzle-kit check)...${c.reset}\n`);

  // drizzle-kit check compares schema.ts against the migration journal snapshots
  // (meta/*.json) without requiring a live database connection.
  const result = spawnSync('npx', ['drizzle-kit', 'check'], {
    cwd: WIKI_SERVER_DIR,
    encoding: 'utf-8',
  });

  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  const exitCode = result.status ?? 1;

  if (result.error) {
    const msg = `Failed to run drizzle-kit check: ${result.error.message}. Ensure drizzle-kit is installed in apps/wiki-server.`;
    console.log(`${c.yellow}Warning: ${msg}${c.reset}`);
    details.push(msg);
    warnings++;
    return { passed: true, warnings, errors: 0, details };
  }

  // Filter out ExperimentalWarning noise from Node.js
  const cleanOutput = output
    .split('\n')
    .filter(l => !l.includes('ExperimentalWarning') && !l.includes('Support for loading ES Module'))
    .join('\n')
    .trim();

  if (exitCode === 0) {
    console.log(`${c.green}Schema and migration journal are in sync${c.reset}`);
    if (cleanOutput) console.log(`${c.dim}${cleanOutput}${c.reset}`);
    return { passed: true, warnings: 0, errors: 0, details: [] };
  }

  const msg = `Drizzle schema drift detected — schema.ts has diverged from the migration journal. ` +
    `Run 'drizzle-kit generate' in apps/wiki-server to create a corrective migration.`;
  console.log(`${c.yellow}Warning: ${msg}${c.reset}`);
  if (cleanOutput) console.log(`\n${c.dim}drizzle-kit output:\n${cleanOutput}${c.reset}`);
  details.push(msg);
  warnings++;

  return { passed: true, warnings, errors: 0, details };
}

export function runCheck(): CheckResult {
  const c = getColors();
  const baseSha = process.env.BASE_SHA ?? '';
  const headSha = process.env.HEAD_SHA ?? '';

  if (baseSha && headSha) {
    return runPrDriftCheck(baseSha, headSha, c);
  } else {
    return runDrizzleKitCheck(c);
  }
}

if (process.argv[1]?.includes('validate-schema-drift')) {
  const result = runCheck();
  process.exit(result.errors > 0 ? 1 : 0);
}
