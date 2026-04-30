/**
 * FactBase Verdicts — admin commands for source_check_verdicts (QUA-930).
 *
 * Handles the FactBase-specific surface of the universal sourcing-cleanup
 * tool. The underlying endpoint (`POST /api/sourcing/cleanup-orphans`) was
 * built for QUA-149 to clean up orphan verdicts across every record type;
 * this wrapper hard-codes `--type=fact` so the FactBase ownership boundary
 * is discoverable in the `crux fb` namespace and operators can sweep stale
 * fact verdicts without learning the universal cleanup interface.
 *
 * The structural fix that prevents new orphans is in
 * apps/wiki-server/src/routes/factbase/facts.ts (`/prune` cascade). This
 * command exists for one-shot cleanup of legacy orphans and as a recovery
 * tool if the cascade ever regresses.
 *
 * Usage:
 *   crux fb verdicts prune-orphans              Dry-run (default)
 *   crux fb verdicts prune-orphans --apply      Actually delete
 *   crux fb verdicts prune-orphans --ci         JSON output
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  cleanupOrphanVerdicts,
  type CleanupOrphansResult,
} from '../lib/wiki-server/sourcing-client.ts';

interface VerdictsOptions extends BaseOptions {
  apply?: boolean;
  'dry-run'?: boolean;
  ci?: boolean;
}

const FACT_RECORD_TYPE = 'fact';

function formatPruneOrphans(result: CleanupOrphansResult): string {
  const lines: string[] = [];
  const { dryRun, deleted, byType } = result;
  lines.push(
    dryRun
      ? '\x1b[1mFactBase Orphan Verdict Prune (dry-run)\x1b[0m'
      : '\x1b[1;32mFactBase Orphan Verdict Prune — applied\x1b[0m',
  );
  lines.push('');

  const factCounts =
    byType[FACT_RECORD_TYPE] ?? { verdicts: 0, evidence: 0, suggestions: 0 };
  const total =
    factCounts.verdicts + factCounts.evidence + factCounts.suggestions;

  if (total === 0) {
    lines.push('No orphan fact verdicts found. Nothing to do.');
    return lines.join('\n');
  }

  lines.push(`  Verdicts:    ${factCounts.verdicts.toLocaleString()}`);
  lines.push(`  Evidence:    ${factCounts.evidence.toLocaleString()}`);
  lines.push(`  Suggestions: ${factCounts.suggestions.toLocaleString()}`);
  lines.push('');

  // Sanity check: deleted.* aggregates across all types, but we asked for
  // only `fact`. If those drift, the server returned data we didn't expect
  // and the user should know.
  if (
    deleted.verdicts !== factCounts.verdicts ||
    deleted.evidence !== factCounts.evidence ||
    deleted.suggestions !== factCounts.suggestions
  ) {
    lines.push(
      '\x1b[33mWarning: server returned non-fact rows in the byType breakdown ' +
        '(scoped request was --type=fact). Investigate before re-running.\x1b[0m',
    );
    lines.push('');
  }

  if (dryRun) {
    lines.push(
      'This was a dry run. Re-run with \x1b[1m--apply\x1b[0m to delete these rows.',
    );
  } else {
    lines.push('\x1b[32mDeletion complete.\x1b[0m');
  }
  return lines.join('\n');
}

async function pruneOrphansCommand(
  _args: string[],
  options: VerdictsOptions,
): Promise<CommandResult> {
  // QUA-930: --dry-run is documented in the ticket; accept both --dry-run
  // and the cleanup-orphans --apply convention so users coming from either
  // command get a working invocation.
  const explicitApply = Boolean(options.apply);
  const explicitDryRun = Boolean(options['dry-run']);
  if (explicitApply && explicitDryRun) {
    return {
      exitCode: 2,
      output: 'Error: --apply and --dry-run are mutually exclusive.',
    };
  }
  const dryRun = explicitDryRun || !explicitApply;

  const response = await cleanupOrphanVerdicts({
    dryRun,
    recordType: FACT_RECORD_TYPE,
  });

  if (!response.ok) {
    return {
      exitCode: 1,
      output: `Failed to prune orphan fact verdicts: ${response.message}`,
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
    output: formatPruneOrphans(result),
  };
}

// ---- Dispatcher (matches the `crux fb sourcing` pattern) ----

async function verdictsCommand(
  args: string[],
  options: VerdictsOptions,
): Promise<CommandResult> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'prune-orphans':
      return pruneOrphansCommand(rest, options);
    case undefined:
    case '--help':
    case 'help':
      return {
        exitCode: 0,
        output: getHelp(),
      };
    default:
      return {
        exitCode: 1,
        output:
          `Unknown verdicts subcommand: ${sub}\n\n` + getHelp(),
      };
  }
}

export function getHelp(): string {
  return `
crux fb verdicts — admin tools for source_check_verdicts (FactBase scope)

Subcommands:
  prune-orphans              Delete fact verdicts whose record_id no longer
                             matches a row in the facts table.

Options:
  --dry-run                  Default. Reports what would be deleted.
  --apply                    Actually delete (required to mutate).
  --ci                       JSON output for scripts.

Examples:
  crux fb verdicts prune-orphans                  Dry-run, fact-typed only
  crux fb verdicts prune-orphans --apply          Delete orphans
  crux fb verdicts prune-orphans --apply --ci     JSON output

See also:
  crux sourcing-cleanup-orphans                   Universal version (all types)
`.trim();
}

// ---- Exports ----

export const commands = {
  default: verdictsCommand,
};
