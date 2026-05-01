/**
 * Migrations command — utilities for managing Drizzle migration files.
 *
 * Currently exposes a single subcommand:
 *
 *   crux migrations renumber [--dry-run]
 *
 *     Detect duplicate idx values, mismatched filename prefixes, or non-
 *     strictly-increasing `when` timestamps in `apps/wiki-server/drizzle/`
 *     and resolve them by renumbering migrations into a clean sequence.
 *
 *     This is the manual fallback when the `drizzle-journal` git merge
 *     driver (crux/git/drizzle-journal-merge.ts) failed mid-rebase or when
 *     someone hand-edited migration files and got them out of sync.
 *
 * Usage:
 *
 *     # Detect-only — show what would change, exit 1 if anything is out of order
 *     crux migrations renumber --dry-run
 *
 *     # Apply — rewrite the journal and `git mv` the .sql files
 *     crux migrations renumber
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { getColors } from '../lib/output.ts';
import {
  applyRenames,
  renumberJournal,
  serializeJournal,
} from '../git/drizzle-journal-merge.mjs';

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

interface RenumberOptions extends CommandOptions {
  dryRun?: boolean;
  drizzleDir?: string;
}

const DEFAULT_DRIZZLE_DIR = 'apps/wiki-server/drizzle';

async function renumberCommand(
  _args: string[],
  options: RenumberOptions,
): Promise<CommandResult> {
  const c = getColors();
  const drizzleDir = options.drizzleDir ?? DEFAULT_DRIZZLE_DIR;
  const journalPath = join(drizzleDir, 'meta', '_journal.json');

  if (!existsSync(journalPath)) {
    return {
      output: `${c.red}Journal not found at ${journalPath}${c.reset}\n`,
      exitCode: 1,
    };
  }

  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal;
  } catch (err) {
    return {
      output: `${c.red}Failed to parse ${journalPath}: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Compute the renumbered journal. The shared helper handles idx
  // reassignment, tag rewriting, and `when` monotonicity.
  const result = renumberJournal(journal);

  if (result.renames.length === 0) {
    // Nothing to rename — but we still need to check whether any other
    // attribute changed (e.g., a `when` bump for monotonicity). Compare the
    // serialized forms to detect that.
    const before = JSON.stringify(journal);
    const after = JSON.stringify(result.resolved);
    if (before === after) {
      return {
        output: `${c.green}Journal is already in canonical form (${journal.entries.length} entries, no renumbering needed).${c.reset}\n`,
        exitCode: 0,
      };
    }
  }

  let output = `${c.blue}Renumbering ${journal.entries.length} migration entries...${c.reset}\n\n`;

  if (result.renames.length > 0) {
    output += `${c.yellow}${result.renames.length} migration${result.renames.length === 1 ? '' : 's'} need renaming:${c.reset}\n`;
    for (const { oldTag, newTag } of result.renames) {
      output += `  ${c.dim}${oldTag}.sql${c.reset} → ${c.green}${newTag}.sql${c.reset}\n`;
    }
    output += '\n';
  }

  // Detect any `when` adjustments — useful diagnostic when the journal had
  // duplicate timestamps before this run (which silently breaks production).
  const whenChanges: Array<{ tag: string; oldWhen: number; newWhen: number }> = [];
  const oldByTag = new Map(journal.entries.map((e) => [e.tag, e.when]));
  // Note: after renumberJournal, the entry's `tag` may have changed. Match
  // by the original tag via the rename map.
  const renameMap = new Map(result.renames.map((r) => [r.newTag, r.oldTag]));
  for (const e of result.resolved.entries) {
    const originalTag = renameMap.get(e.tag) ?? e.tag;
    const oldWhen = oldByTag.get(originalTag);
    if (oldWhen !== undefined && oldWhen !== e.when) {
      whenChanges.push({ tag: e.tag, oldWhen, newWhen: e.when });
    }
  }
  if (whenChanges.length > 0) {
    output += `${c.yellow}${whenChanges.length} 'when' timestamp${whenChanges.length === 1 ? '' : 's'} bumped for strict monotonicity:${c.reset}\n`;
    for (const { tag, oldWhen, newWhen } of whenChanges) {
      output += `  ${c.dim}${tag}: ${oldWhen} → ${newWhen}${c.reset}\n`;
    }
    output += '\n';
  }

  if (options.dryRun) {
    output += `${c.dim}--dry-run: no files modified.${c.reset}\n`;
    return { output, exitCode: result.renames.length > 0 || whenChanges.length > 0 ? 1 : 0 };
  }

  // Apply renames to the worktree.
  const repoRoot = findRepoRoot();
  try {
    const { renamed, alreadyRenamed, skipped } = applyRenames(result.renames, drizzleDir, repoRoot);
    if (renamed > 0) {
      output += `${c.green}Renamed ${renamed} file${renamed === 1 ? '' : 's'}.${c.reset}\n`;
    }
    if (alreadyRenamed > 0) {
      output += `${c.dim}${alreadyRenamed} file${alreadyRenamed === 1 ? '' : 's'} already at the new path (idempotent re-run).${c.reset}\n`;
    }
    for (const note of skipped) {
      output += `  ${c.dim}skipped: ${note}${c.reset}\n`;
    }
  } catch (err) {
    return {
      output: output + `${c.red}Failed to rename migration files: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Write the rewritten journal.
  try {
    writeFileSync(journalPath, serializeJournal(result.resolved));
  } catch (err) {
    return {
      output: output + `${c.red}Failed to write ${journalPath}: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`,
      exitCode: 1,
    };
  }

  output += `\n${c.green}Done. Stage the journal change with:${c.reset} ${c.dim}git add ${journalPath}${c.reset}\n`;
  return { output, exitCode: 0 };
}

function findRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

export const commands: Record<
  string,
  (args: string[], options: CommandOptions) => Promise<CommandResult>
> = {
  renumber: renumberCommand,
};

export function getHelp(): string {
  return `
Migrations — Drizzle migration file utilities

Subcommands:
  renumber [--dry-run]   Renumber migration files into a clean sequence.
                          Detects duplicate idx values, mismatched filename
                          prefixes, or non-monotonic 'when' timestamps.

This is the manual fallback when the drizzle-journal git merge driver
couldn't auto-resolve a conflict, or when migration files were hand-edited
and got out of sync with the journal.

Examples:
  pnpm crux migrations renumber --dry-run    # Detect issues
  pnpm crux migrations renumber              # Fix in place
`;
}
