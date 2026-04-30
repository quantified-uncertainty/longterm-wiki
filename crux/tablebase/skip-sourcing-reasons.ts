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
