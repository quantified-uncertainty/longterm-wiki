/**
 * Ticket-sizing red-flag detector.
 *
 * Scans a candidate ticket title + description for patterns that empirically
 * predict a ticket will need to be split mid-session. See
 * `docs/agent-rules/ticket-sizing.md` for the rule that motivates each pattern
 * and QUA-575 for the originating incidents.
 *
 * The detector is intentionally regex-based and conservative — false positives
 * are escapable via `--allow-big` on `crux linear create`, and the cost of a
 * spurious warning is much lower than the cost of an oversized ticket making
 * it past filing.
 */

import { formatCount } from '../output.ts';

export type RedFlagKind =
  | 'phase-or-wave'
  | 'row-count-batching'
  | 'mixed-shapes'
  | 'multi-table-enumeration';

export interface RedFlag {
  kind: RedFlagKind;
  /** The exact substring of the input that fired the rule. */
  match: string;
  /** Human-readable explanation, including a pointer to the rule file. */
  reason: string;
}

interface Detector {
  kind: RedFlagKind;
  pattern: RegExp;
  reason: string;
}

const DETECTORS: Detector[] = [
  {
    kind: 'phase-or-wave',
    pattern: /\b(phase|wave) [0-9ABC]+\b/i,
    reason:
      'Phase/Wave language implies multi-step work — each step is usually its own ticket.',
  },
  {
    // Anchor on a leading digit so degenerate inputs like "migrate ,5" or
    // "migrate ,," can't match. Trailing chars allow comma-grouping ("5,000").
    kind: 'row-count-batching',
    pattern: /\b(migrate|backfill|populate|rewrite) [0-9][0-9,]*\b/i,
    reason:
      'Row-count batching mixes PR-shaped plumbing with budget-gated execution — file as separate tickets.',
  },
  {
    kind: 'mixed-shapes',
    pattern: /\b(audit and|design and)\b/i,
    reason:
      'Mixed shapes (audit+implement, design+execute) have different completion semantics — split at the "and".',
  },
  {
    // ≥3 backtick-delimited identifiers separated by commas. The trailing
    // {2,} on the second-and-onward groups means we need at least three
    // total identifiers to fire.
    kind: 'multi-table-enumeration',
    pattern: /`[A-Za-z_][A-Za-z0-9_]*`(?:\s*,\s*`[A-Za-z_][A-Za-z0-9_]*`){2,}/,
    reason:
      '≥3 enumerated code surfaces in one ticket — PR will span multiple review areas; group by code footprint and split.',
  },
];

/**
 * Detect ticket-sizing red flags in a title + description.
 *
 * Returns one entry per kind of flag fired (deduplicated by `kind` so a
 * description that says "Phase 1" and "Phase 2" doesn't generate two
 * `phase-or-wave` warnings). Within a kind, `match` is the first occurrence.
 */
export function detectRedFlags(title: string, description: string): RedFlag[] {
  const haystack = [title, description].filter(Boolean).join('\n');
  const out: RedFlag[] = [];
  for (const det of DETECTORS) {
    const m = det.pattern.exec(haystack);
    if (m) out.push({ kind: det.kind, match: m[0], reason: det.reason });
  }
  return out;
}

/**
 * Format detected red flags as a human-readable warning block. Caller chooses
 * stdout vs stderr; this function returns a plain string with no ANSI codes
 * so it's safe for both.
 */
export function formatRedFlagsWarning(flags: RedFlag[]): string {
  if (flags.length === 0) return '';
  let out = `⚠ Ticket-sizing ${formatCount(flags.length, 'red flag')} detected:\n`;
  for (const f of flags) {
    out += `  • [${f.kind}] matched "${f.match}"\n`;
    out += `    ${f.reason}\n`;
  }
  out += '\n';
  out += 'Why this matters: oversized tickets get split mid-session, costing\n';
  out += '~30-60min of coordination overhead each time. See\n';
  out += 'docs/agent-rules/ticket-sizing.md for the full rule and decomposition\n';
  out += 'guidance.\n';
  out += '\n';
  out += 'To proceed anyway (the ticket is legitimately large and atomic),\n';
  out += 're-run with --allow-big.\n';
  return out;
}
