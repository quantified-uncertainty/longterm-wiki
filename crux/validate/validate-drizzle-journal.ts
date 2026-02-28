#!/usr/bin/env node

/**
 * Validate Drizzle migration journal integrity:
 *
 * 1. Every migration SQL file must be registered in the journal.
 *    drizzle-kit generate creates the .sql file automatically but never updates
 *    _journal.json. This causes migrations to be silently skipped on every
 *    server restart/deploy. This check catches that before push.
 *
 * 2. Migration file prefixes (the numeric part, e.g. 0032) must be unique.
 *    Duplicate prefixes arise from branch merges and make the migration order
 *    ambiguous. Known historical duplicates are grandfathered; new ones fail.
 *
 * The journal uses sequential `idx` values and `tag` = filename without .sql.
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

interface DuplicatePrefix {
  prefix: string;
  files: string[];
}

interface CheckResult {
  passed: boolean;
  errors: number;
  missing: string[];
  duplicatePrefixes: DuplicatePrefix[];
  sqlFiles: string[];
  journalTags: string[];
}

// Historical duplicate prefixes that already exist in the codebase.
// These are grandfathered — only NEW duplicates will fail the check.
// All historical duplicates were resolved in the migration cleanup PR.
const KNOWN_DUPLICATE_PREFIXES = new Set<string>([
]);

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
    return { passed: true, errors: 0, missing: [], duplicatePrefixes: [], sqlFiles: [], journalTags: [] };
  }

  // Read journal
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as Journal;
  } catch (err) {
    console.log(`${c.red}Failed to read journal at ${JOURNAL_PATH}: ${err}${c.reset}`);
    return { passed: false, errors: 1, missing: [JOURNAL_PATH], duplicatePrefixes: [], sqlFiles, journalTags: [] };
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

  // Check for duplicate migration prefixes (the numeric part like "0032")
  const prefixMap = new Map<string, string[]>();
  for (const tag of sqlFiles) {
    const match = tag.match(/^(\d+)_/);
    if (match) {
      const prefix = match[1];
      if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
      prefixMap.get(prefix)!.push(tag);
    }
  }

  const newDuplicates: DuplicatePrefix[] = [];
  for (const [prefix, files] of prefixMap) {
    if (files.length > 1 && !KNOWN_DUPLICATE_PREFIXES.has(prefix)) {
      newDuplicates.push({ prefix, files });
    }
  }

  if (newDuplicates.length > 0) {
    console.log(
      `\n${c.red}Found ${newDuplicates.length} new duplicate migration prefix(es):${c.reset}\n`
    );
    for (const dup of newDuplicates) {
      console.log(`  ${c.red}Prefix ${dup.prefix}:${c.reset}`);
      for (const file of dup.files) {
        console.log(`    ${c.red}${file}.sql${c.reset}`);
      }
    }
    console.log();
    console.log(
      `${c.dim}Fix: renumber one of the conflicting migrations to the next available prefix.${c.reset}`
    );
    console.log(
      `${c.dim}Duplicate prefixes make migration order ambiguous across environments.${c.reset}`
    );
  } else {
    const knownCount = [...prefixMap.values()].filter(f => f.length > 1).length;
    const knownNote = knownCount > 0 ? ` (${knownCount} known historical duplicates grandfathered)` : '';
    console.log(
      `${c.green}No new duplicate migration prefixes${c.reset}${c.dim}${knownNote}${c.reset}`
    );
  }

  // Check for duplicate idx values and non-strictly-increasing `when` timestamps.
  // Duplicate `when` values cause the Drizzle migrator to silently skip migrations
  // (it compares `created_at < folderMillis`, so equal values are not applied).
  const journalIssues: string[] = [];
  const seenIdx = new Set<number>();
  const seenWhen = new Set<number>();
  let prevWhen = 0;
  for (const entry of journal.entries) {
    if (seenIdx.has(entry.idx)) {
      journalIssues.push(`Duplicate idx=${entry.idx} for tag ${entry.tag}`);
    }
    seenIdx.add(entry.idx);

    if (seenWhen.has(entry.when)) {
      journalIssues.push(`Duplicate when=${entry.when} for tag ${entry.tag} — will cause migration to be skipped`);
    }
    seenWhen.add(entry.when);

    if (entry.when <= prevWhen) {
      journalIssues.push(`Non-increasing when=${entry.when} for tag ${entry.tag} (previous: ${prevWhen})`);
    }
    prevWhen = entry.when;
  }

  if (journalIssues.length > 0) {
    console.log(
      `\n${c.red}Found ${journalIssues.length} journal ordering issue(s):${c.reset}\n`
    );
    for (const issue of journalIssues) {
      console.log(`  ${c.red}${issue}${c.reset}`);
    }
    console.log();
    console.log(
      `${c.dim}Fix: ensure all idx values are sequential and all when values are strictly increasing.${c.reset}`
    );
    console.log(
      `${c.dim}Duplicate when values cause the Drizzle migrator to silently skip migrations.${c.reset}`
    );
  } else {
    console.log(
      `${c.green}Journal ordering is correct (sequential idx, strictly increasing when)${c.reset}`
    );
  }

  const totalErrors = missing.length + newDuplicates.length + journalIssues.length;

  return {
    passed: totalErrors === 0,
    errors: totalErrors,
    missing,
    duplicatePrefixes: newDuplicates,
    sqlFiles,
    journalTags: [...journalTags],
  };
}

if (process.argv[1]?.includes('validate-drizzle-journal')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
