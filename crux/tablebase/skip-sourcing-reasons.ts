/**
 * Controlled vocabulary for `--skip-sourcing` justifications.
 *
 * Background (QUA-730): the original `--skip-sourcing` flag only logged a
 * generic "cli: --skip-sourcing flag set by caller" string when bypassing
 * server-side `enforceSourcing`. PR #4612 used it because
 * `ANTHROPIC_BILLING_KEY` was missing, and 81 personnel records shipped
 * to production with `verdict: "none"` for every row. Across 71 manifests
 * (Mar–Apr 2026) only 9% of records ended up with sourcing data attached.
 *
 * Requiring a reason from this allowlist forces the caller to acknowledge
 * which class of bypass they are using, and gives the manifest + audit log
 * a clean, greppable label.
 */

export const SKIP_SOURCING_REASONS = [
  'migration',
  'backfill',
  'testing',
  'key-unavailable',
  'manual-verified',
] as const;

export type SkipSourcingReason = (typeof SKIP_SOURCING_REASONS)[number];

const SKIP_SOURCING_REASON_DESCRIPTIONS: Record<SkipSourcingReason, string> = {
  migration: 'Bulk historical data migration where source URLs predate the cache.',
  backfill: 'Re-ingesting an existing dataset whose verdicts already exist elsewhere.',
  testing: 'Local development or CI test run; records are not bound for production.',
  'key-unavailable': 'ANTHROPIC_BILLING_KEY (or equivalent) missing in the runtime environment.',
  'manual-verified': 'Operator verified records by inspection before submission.',
};

export function isSkipSourcingReason(value: unknown): value is SkipSourcingReason {
  return (
    typeof value === 'string' &&
    (SKIP_SOURCING_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Build a human-readable error message for an invalid (or missing) reason.
 * Used by both the CLI submit command and the agent-tool handler so callers
 * see the same vocabulary list.
 */
export function formatSkipSourcingReasonError(provided: string | undefined): string {
  const lines: string[] = [];
  if (!provided) {
    lines.push(
      'Error: --skip-sourcing requires --skip-sourcing-reason=<value> (QUA-730).',
    );
  } else {
    lines.push(
      `Error: --skip-sourcing-reason="${provided}" is not in the controlled vocabulary (QUA-730).`,
    );
  }
  lines.push('');
  lines.push('Allowed reasons:');
  for (const reason of SKIP_SOURCING_REASONS) {
    lines.push(`  - ${reason}: ${SKIP_SOURCING_REASON_DESCRIPTIONS[reason]}`);
  }
  return lines.join('\n');
}

/**
 * Format the `reason=` query-param value forwarded to wiki-server so the
 * audit log captures both the controlled-vocabulary tag and the calling path.
 */
export function formatSkipSourcingAuditReason(
  reason: SkipSourcingReason,
  callerLabel: string,
): string {
  return `${callerLabel}: skip-sourcing reason=${reason}`;
}

/**
 * Subset of the CLI options used by the reason check. Defined narrowly so the
 * helper can live next to the vocabulary instead of the CLI-options interface.
 */
interface SkipSourcingOptions {
  skipSourcing?: boolean;
  skipSourcingReason?: string;
}

/**
 * Result returned by `checkSkipSourcingReason` — shaped to match the CLI
 * `CommandResult` contract so callers can `if (err) return err` without
 * importing extra types.
 */
export interface SkipSourcingCheckError {
  exitCode: 2;
  output: string;
}

/**
 * Pre-flight reason check shared by every CLI command that forwards the
 * `--skip-sourcing` flag (submit, improve, field-improve, loop). Exit code 2
 * matches `crux linear`'s "policy rejection" convention; exit 1 is reserved
 * for runtime errors.
 *
 * Returns `null` when the call is well-formed (or `--skip-sourcing` is
 * absent). Returns a CommandResult-shaped object that the CLI command should
 * forward as its own return value when the reason is missing or invalid.
 */
export function checkSkipSourcingReason(
  options: SkipSourcingOptions,
): SkipSourcingCheckError | null {
  if (!options.skipSourcing) return null;
  const provided = options.skipSourcingReason?.trim();
  if (!isSkipSourcingReason(provided)) {
    return { exitCode: 2, output: formatSkipSourcingReasonError(provided) };
  }
  return null;
}

/**
 * Yellow ANSI banner emitted by both the CLI submit command and the agent
 * tool handler before a `--skip-sourcing` submission. Single source of truth
 * so the two paths can't drift on width / wording.
 */
export function formatSkipSourcingBanner(args: {
  source: 'cli' | 'agent';
  recordCount: number;
  table: string;
  reason: SkipSourcingReason;
}): string {
  const bar = '═'.repeat(72);
  const sourceLabel = args.source === 'cli' ? '--skip-sourcing' : 'agent --skipSourcing';
  return [
    `\x1b[33m${bar}\x1b[0m`,
    `\x1b[33m  ⚠  ${sourceLabel}: shipping ${args.recordCount} ${args.table} record(s)\x1b[0m`,
    `\x1b[33m     to production WITHOUT sourcing verification.\x1b[0m`,
    `\x1b[33m     Reason: ${args.reason}\x1b[0m`,
    `\x1b[33m${bar}\x1b[0m`,
  ].join('\n');
}
