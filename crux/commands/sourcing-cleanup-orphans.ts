/**
 * Sourcing Orphan Cleanup (QUA-149)
 *
 * Deletes sourcing verdict / evidence / url-suggestion rows whose record
 * no longer exists in its source table. Dashboard queries already filter these
 * out at read time, but the raw COUNT(*)s (e.g., 1002 personnel verdicts for
 * 724 records) are what made the coverage matrix show nonsense like 127%.
 *
 * Usage:
 *   crux sourcing-cleanup-orphans                  Dry-run, all known types
 *   crux sourcing-cleanup-orphans --apply          Actually delete
 *   crux sourcing-cleanup-orphans --type=personnel Scope to one record type
 *   crux sourcing-cleanup-orphans --ci             Machine-readable JSON output
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { cleanupOrphanVerdicts, type CleanupOrphansResult } from '../lib/wiki-server/sourcing-client.ts';

interface CleanupOptions extends BaseOptions {
  apply?: boolean;
  type?: string;
  ci?: boolean;
}

function formatOutput(result: CleanupOrphansResult): string {
  const lines: string[] = [];
  const { dryRun, deleted, byType } = result;
  const header = dryRun
    ? '\x1b[1mSource-Check Orphan Cleanup (dry-run)\x1b[0m'
    : '\x1b[1;32mSource-Check Orphan Cleanup — applied\x1b[0m';
  lines.push(header);
  lines.push('');

  const total = deleted.verdicts + deleted.evidence + deleted.suggestions;
  if (total === 0) {
    lines.push('No orphan rows found. Nothing to do.');
    return lines.join('\n');
  }

  lines.push(`  Verdicts:    ${deleted.verdicts.toLocaleString()}`);
  lines.push(`  Evidence:    ${deleted.evidence.toLocaleString()}`);
  lines.push(`  Suggestions: ${deleted.suggestions.toLocaleString()}`);
  lines.push('');

  const byTypeEntries = Object.entries(byType).sort(
    ([, a], [, b]) => (b.verdicts + b.evidence + b.suggestions) - (a.verdicts + a.evidence + a.suggestions),
  );
  if (byTypeEntries.length > 0) {
    lines.push('By record type:');
    const maxTypeLen = Math.max(...byTypeEntries.map(([t]) => t.length));
    for (const [type, counts] of byTypeEntries) {
      lines.push(
        `  ${type.padEnd(maxTypeLen)}  verdicts=${counts.verdicts}  evidence=${counts.evidence}  suggestions=${counts.suggestions}`,
      );
    }
    lines.push('');
  }

  if (dryRun) {
    lines.push('This was a dry run. Re-run with \x1b[1m--apply\x1b[0m to delete these rows.');
  } else {
    lines.push('\x1b[32mDeletion complete.\x1b[0m');
  }
  return lines.join('\n');
}

async function cleanupCommand(
  _args: string[],
  options: CleanupOptions,
): Promise<CommandResult> {
  const apply = Boolean(options.apply);
  const recordType = options.type as string | undefined;

  const response = await cleanupOrphanVerdicts({
    dryRun: !apply,
    recordType,
  });

  if (!response.ok) {
    return {
      exitCode: 1,
      output: `Failed to clean up orphans: ${response.message}`,
    };
  }

  const result = response.data;

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify(result, null, 2),
    };
  }

  return {
    exitCode: 0,
    output: formatOutput(result),
  };
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: cleanupCommand,
};

export function getHelp(): string {
  return `
Source-Check Orphan Cleanup — delete verdict/evidence rows for deleted records

Background:
  Dashboard queries filter out "orphan" verdicts (rows referencing records
  that have been deleted from their source table) at read time, but the raw
  rows accumulate. This skews raw COUNT(*) statistics and has produced
  visible bugs like "personnel coverage 127%" in the coverage matrix.

Usage:
  crux sourcing-cleanup-orphans                  Dry-run over all known types
  crux sourcing-cleanup-orphans --apply          Actually delete orphan rows
  crux sourcing-cleanup-orphans --type=personnel Scope to one record type
  crux sourcing-cleanup-orphans --ci             Machine-readable JSON output

Options:
  --apply     Delete matched rows (default is dry-run)
  --type=X    Filter by record type (e.g., personnel, grant, fact)
  --ci        JSON output for CI pipelines

Safety:
  - Default is dry-run. You must pass --apply to delete.
  - Only record_types listed in LIVE_RECORDS_CTE are touched. Rows with an
    unknown record_type are left alone.
  - With --apply, all three DELETEs run in one transaction (rolled back on
    any error) and the reported counts come from DELETE ... RETURNING, so
    they exactly match what was removed — no SELECT/DELETE drift.
  - Dry-run counts come from a SELECT and may legitimately drift from a
    later --apply if the database changes between the two calls.
`.trim();
}
