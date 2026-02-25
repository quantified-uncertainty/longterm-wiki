#!/usr/bin/env node

/**
 * Validate that every Drizzle migration SQL file is registered in the journal.
 *
 * drizzle-kit generate creates the .sql file automatically but never updates
 * _journal.json. This causes migrations to be silently skipped on every server
 * restart/deploy. This check catches that before push.
 *
 * The journal uses sequential `idx` values and `tag` = filename without .sql.
 * Duplicate-numbered files (e.g. two 0022_* files from branch merges) are
 * handled correctly: both must have journal entries; only missing tags fail.
 *
 * Usage: npx tsx crux/validate/validate-drizzle-journal.ts
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getColors } from '../lib/output.ts';

const DRIZZLE_DIR = 'apps/wiki-server/drizzle';
const JOURNAL_PATH = join(DRIZZLE_DIR, 'meta/_journal.json');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface CheckResult {
  passed: boolean;
  errors: number;
  missing: string[];
  sqlFiles: string[];
  journalTags: string[];
}

export function runCheck(): CheckResult {
  const c = getColors();
  console.log(`${c.blue}Checking Drizzle migration journal integrity...${c.reset}\n`);

  // Read SQL files
  let sqlFiles: string[];
  try {
    sqlFiles = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
  } catch {
    console.log(`${c.dim}Skipping: ${DRIZZLE_DIR} not found${c.reset}`);
    return { passed: true, errors: 0, missing: [], sqlFiles: [], journalTags: [] };
  }

  // Read journal
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as Journal;
  } catch (err) {
    console.log(`${c.red}Failed to read journal at ${JOURNAL_PATH}: ${err}${c.reset}`);
    return { passed: false, errors: 1, missing: [JOURNAL_PATH], sqlFiles, journalTags: [] };
  }

  const journalTags = new Set(journal.entries.map((e) => e.tag));

  // Find SQL files with no matching journal entry
  const missing = sqlFiles.filter((tag) => !journalTags.has(tag));

  if (missing.length === 0) {
    console.log(
      `${c.green}All ${sqlFiles.length} migration files are registered in the journal${c.reset}`
    );
  } else {
    console.log(
      `${c.red}Found ${missing.length} migration file${missing.length > 1 ? 's' : ''} not registered in ${JOURNAL_PATH}:${c.reset}\n`
    );
    for (const tag of missing) {
      console.log(`  ${c.red}${tag}.sql${c.reset}`);
    }
    console.log();
    console.log(
      `${c.dim}Fix: add an entry for each missing tag to ${JOURNAL_PATH}${c.reset}`
    );
    console.log(
      `${c.dim}Each entry needs: idx (next sequential), version, when (epoch ms), tag, breakpoints: true${c.reset}`
    );
    console.log(
      `${c.dim}Without this, the Drizzle migrator will silently skip these migrations on every deploy.${c.reset}`
    );
  }

  return {
    passed: missing.length === 0,
    errors: missing.length,
    missing,
    sqlFiles,
    journalTags: [...journalTags],
  };
}

if (process.argv[1]?.includes('validate-drizzle-journal')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
