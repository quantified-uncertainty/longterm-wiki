/**
 * Review patterns command — QUA-363 option E.
 *
 * Verifies that every pattern item in the current session checklist has
 * been either:
 *   - Explicitly checked off (reviewer confirmed no finding or addressed it)
 *   - Marked `--na` with a reason
 *
 * Exits non-zero if any `review-*` item is still unchecked, blocking
 * `/agent-review-pr` from claiming a clean pass.
 *
 * The mechanic: the diff-triggered checklist items (option B) are sitting
 * in `.claude/wip-checklist.md`. This command parses that file, finds
 * every `review-<pattern-id>` item, and attests that the reviewer visited
 * each one. Combined with the `agent-checklist complete` step, unaddressed
 * patterns cannot silently slip through.
 *
 * Usage:
 *   crux gh review-patterns check         # exit 0 if all attested, 1 otherwise
 *   crux gh review-patterns list          # show all review-* items + status
 *   crux gh review-patterns list --json   # JSON output for tools
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { CommandResult, CommandOptions } from '../lib/command-types.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { parseChecklist, type ParsedItem } from '../lib/session/session-checklist.ts';
import { getPatternById, PATTERNS } from '../lib/review-patterns/patterns.ts';
import { createLogger } from '../lib/output.ts';

const CHECKLIST_PATH = join(PROJECT_ROOT, '.claude/wip-checklist.md');

interface PatternCheckResult {
  id: string;
  patternId: string;
  label: string;
  status: 'checked' | 'unchecked' | 'na';
  naReason?: string;
  /** The pattern's registered reason string, for context. */
  reason: string;
}

/**
 * Pure function — given a parsed checklist, return all pattern attestation items.
 * Exported for tests.
 */
export function collectPatternAttestations(items: ParsedItem[]): PatternCheckResult[] {
  const out: PatternCheckResult[] = [];
  for (const item of items) {
    if (!item.id.startsWith('review-')) continue;
    const patternId = item.id.slice('review-'.length);
    const pattern = getPatternById(patternId);
    out.push({
      id: item.id,
      patternId,
      label: item.label,
      status: item.status,
      naReason: item.naReason,
      reason: pattern?.reason ?? '(unknown pattern — not in registry)',
    });
  }
  return out;
}

/**
 * Determine whether all pattern items have been attested.
 * `checked` or `na` counts as attested. `unchecked` is a block.
 */
export function allAttested(results: PatternCheckResult[]): boolean {
  return results.every((r) => r.status !== 'unchecked');
}

function loadChecklistItems(): ParsedItem[] | null {
  if (!existsSync(CHECKLIST_PATH)) return null;
  const md = readFileSync(CHECKLIST_PATH, 'utf-8');
  return parseChecklist(md).items;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

// handler-safe: pure presentation over an already-parsed checklist file
async function check(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const items = loadChecklistItems();
  if (!items) {
    return {
      exitCode: 1,
      output:
        `${c.red}No checklist found at ${CHECKLIST_PATH}.${c.reset}\n` +
        `Run \`pnpm crux sys agent-checklist init "task" --type=X\` first.\n`,
    };
  }

  const results = collectPatternAttestations(items);
  if (options.json) {
    return {
      exitCode: allAttested(results) ? 0 : 1,
      output: JSON.stringify({ ok: allAttested(results), items: results }, null, 2),
    };
  }

  if (results.length === 0) {
    return {
      exitCode: 0,
      output: `${c.green}✓ No review-pattern items in checklist (nothing to attest).${c.reset}\n`,
    };
  }

  const lines: string[] = [];
  lines.push('Review pattern attestation:');
  lines.push('');
  for (const r of results) {
    const icon =
      r.status === 'checked' ? `${c.green}✓${c.reset}` :
      r.status === 'na' ? `${c.dim}~${c.reset}` :
      `${c.red}✗${c.reset}`;
    lines.push(`  ${icon} ${r.id}`);
    if (r.status === 'na' && r.naReason) {
      lines.push(`      ${c.dim}N/A: ${r.naReason}${c.reset}`);
    }
  }

  if (allAttested(results)) {
    lines.push('');
    lines.push(`${c.green}✓ All ${results.length} pattern item(s) attested.${c.reset}`);
    return { exitCode: 0, output: lines.join('\n') + '\n' };
  }

  const unchecked = results.filter((r) => r.status === 'unchecked');
  lines.push('');
  lines.push(`${c.red}✗ ${unchecked.length} pattern item(s) still unchecked:${c.reset}`);
  lines.push('');
  for (const r of unchecked) {
    lines.push(`  ${c.bold}${r.id}${c.reset}`);
    lines.push(`    ${c.dim}${r.reason}${c.reset}`);
    lines.push(
      `    ${c.dim}Fix: \`pnpm crux sys agent-checklist check ${r.id}\` (after addressing),\n` +
      `         or \`... check --na ${r.id} --reason "why this pattern doesn't apply here"\`${c.reset}`,
    );
    lines.push('');
  }
  return { exitCode: 1, output: lines.join('\n') };
}

// handler-safe: presentation-only
async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  if (options.json) {
    return {
      exitCode: 0,
      output: JSON.stringify(
        PATTERNS.map((p) => ({
          id: p.id,
          label: p.label,
          reason: p.reason,
          origin: p.origin,
          mechanical: p.mechanical,
        })),
        null,
        2,
      ),
    };
  }
  const log = createLogger(options.ci);
  const c = log.colors;
  const lines: string[] = [];
  lines.push(`${c.bold}Review patterns registered (${PATTERNS.length}):${c.reset}`);
  lines.push('');
  for (const p of PATTERNS) {
    const tag = p.mechanical ? `${c.green}[mechanical]${c.reset}` : `${c.dim}[checklist-only]${c.reset}`;
    lines.push(`  ${c.bold}${p.id}${c.reset} ${tag}`);
    lines.push(`    ${p.label}`);
    lines.push(`    ${c.dim}${p.reason}${c.reset}`);
    if (p.origin) lines.push(`    ${c.dim}origin: ${p.origin}${c.reset}`);
    lines.push('');
  }
  return { exitCode: 0, output: lines.join('\n') };
}

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: check,
  check,
  list,
};

export function getHelp(): string {
  return `
Review Patterns — verify /agent-review-pr attested every pattern

Subcommands:
  check        Verify all review-* checklist items are attested (default)
  list         Print the pattern registry

Options:
  --json       JSON output

Exit codes:
  0  — all pattern items checked or marked N/A
  1  — one or more pattern items still unchecked
`;
}
