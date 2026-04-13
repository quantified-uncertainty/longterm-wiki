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
import { parseChecklist, detectPatternItems, type ParsedItem } from '../lib/session/session-checklist.ts';
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

async function check(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean | undefined);
  const c = log.colors;

  let items: ParsedItem[] | null;
  try {
    items = loadChecklistItems();
  } catch (e) {
    const msg = `Failed to read checklist at ${CHECKLIST_PATH}: ${e instanceof Error ? e.message : String(e)}`;
    return {
      exitCode: 1,
      output: options.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `${c.red}${msg}${c.reset}\n`,
    };
  }

  if (!items) {
    return {
      exitCode: 1,
      output:
        `${c.red}No checklist found at ${CHECKLIST_PATH}.${c.reset}\n` +
        `Run \`pnpm crux sys agent-checklist init "task" --type=X\` first.\n`,
    };
  }

  // Freshness check: re-detect patterns from the current diff. If the diff
  // has advanced since `init` (e.g., /agent-review-pr fixed code, or later
  // commits introduced a new bug shape), any newly-triggered pattern would
  // be invisible to the old checklist. Fail closed and point at `init` so
  // the reviewer picks up the new items before shipping.
  //
  // CRITICAL (QUA-363 hostile-review HIGH-2): if the re-detect fails to
  // read the diff (maxBuffer overflow, hung git, missing origin/main),
  // we MUST fail closed. A silent 0-detections result against a broken
  // detector is exactly the invisible-failure bug class the pattern
  // system exists to prevent.
  const {
    items: freshPatternItems,
    diffError: freshDiffError,
  } = detectPatternItems(PROJECT_ROOT);
  if (freshDiffError != null) {
    const msg = `Freshness check could not re-read the current diff: ${freshDiffError}`;
    if (options.json) {
      return {
        exitCode: 1,
        output: JSON.stringify(
          { ok: false, reason: 'diff-unreadable', error: freshDiffError },
          null,
          2,
        ),
      };
    }
    return {
      exitCode: 1,
      output:
        `${c.red}✗ ${msg}${c.reset}\n` +
        `  ${c.dim}Cannot verify the checklist is up to date. Refusing to attest a clean state${c.reset}\n` +
        `  ${c.dim}against a broken detector. Fix the underlying git/filesystem issue, then retry.${c.reset}\n`,
    };
  }
  const existingReviewIds = new Set(
    items.filter((i) => i.id.startsWith('review-')).map((i) => i.id),
  );
  const missingFresh = freshPatternItems.filter(
    (p) => !existingReviewIds.has(p.id),
  );
  if (missingFresh.length > 0) {
    if (options.json) {
      return {
        exitCode: 1,
        output: JSON.stringify(
          {
            ok: false,
            reason: 'stale-checklist',
            missing: missingFresh.map((p) => ({ id: p.id, label: p.label })),
          },
          null,
          2,
        ),
      };
    }
    const lines: string[] = [];
    lines.push(
      `${c.red}✗ ${missingFresh.length} review pattern(s) triggered since checklist was generated:${c.reset}`,
    );
    lines.push('');
    for (const p of missingFresh) {
      lines.push(`  ${c.bold}${p.id}${c.reset} — ${p.label}`);
    }
    lines.push('');
    lines.push(
      `${c.dim}The checklist is stale. Re-run \`pnpm crux sys agent-checklist init\` to refresh,${c.reset}`,
    );
    lines.push(
      `${c.dim}then address each new pattern before retrying ship.${c.reset}`,
    );
    return { exitCode: 1, output: lines.join('\n') + '\n' };
  }

  const results = collectPatternAttestations(items);
  const ok = allAttested(results);

  if (options.json) {
    return {
      exitCode: ok ? 0 : 1,
      output: JSON.stringify({ ok, items: results }, null, 2),
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

  if (ok) {
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
  const log = createLogger(options.ci as boolean | undefined);
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
