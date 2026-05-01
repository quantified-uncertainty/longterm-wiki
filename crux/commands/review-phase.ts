/**
 * Review Phase Tracker Commands — structural enforcement for /agent-review-pr.
 *
 * Records phase execution to `.claude/review-phases-done` so the marker write
 * (`.claude/review-done`) can be gated on full coverage. Each phase appends a
 * line; `validate` checks completeness; `write-marker` is the only path that
 * should write the review marker (replacing the inline `echo > .claude/review-done`
 * pattern that the agent could bypass).
 *
 * See QUA-950 and `.claude/commands/agent-review-pr.md`.
 */

import { existsSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  PHASE_IDS,
  TRACKER_PATH,
  type PhaseId,
  initTracker,
  recordPhase,
  validateTracker,
  readTracker,
  summarizeSkipped,
  computeDiffHash,
  getHeadSha,
} from '../lib/review-phase-tracker.ts';

const MARKER_PATH = join(PROJECT_ROOT, '.claude/review-done');

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  reason?: string;
  json?: boolean;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function init(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let meta;
  try {
    meta = initTracker();
  } catch (err) {
    return {
      output: `${c.red}✗ Failed to initialize tracker: ${(err as Error).message}${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (options.json) {
    return { output: JSON.stringify({ ok: true, ...meta }) + '\n', exitCode: 0 };
  }

  return {
    output:
      `${c.green}✓${c.reset} Review phase tracker initialized\n` +
      `  ${c.dim}File:${c.reset}      ${TRACKER_PATH}\n` +
      `  ${c.dim}Commit:${c.reset}    ${meta.commitSha.slice(0, 12)}\n` +
      `  ${c.dim}Diff hash:${c.reset} ${meta.diffHash}\n` +
      `  ${c.dim}Required phases:${c.reset} ${PHASE_IDS.length}\n` +
      `\n  Use \`crux sys review-phase record <phase-id>\` after each phase.\n`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

async function record(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    return {
      output:
        `${c.red}Usage: crux sys review-phase record <phase-id> [--reason="..."]${c.reset}\n\n` +
        `Valid phase IDs:\n  ${PHASE_IDS.join('\n  ')}\n`,
      exitCode: 1,
    };
  }
  if (positional.length > 1) {
    // Silently dropping extra positional args would let an agent type
    // `record phase-1 phase-2` and only have phase-1 captured. Make it
    // an explicit error so the second phase isn't lost.
    return {
      output:
        `${c.red}record accepts exactly one phase ID, got ${positional.length}: ${positional.join(', ')}${c.reset}\n` +
        `  Run \`crux sys review-phase record <id>\` once per phase.\n`,
      exitCode: 1,
    };
  }
  const phaseId = positional[0];

  const result = recordPhase(phaseId, { reason: options.reason });
  if (!result.ok) {
    return {
      output: `${c.red}✗ ${result.error}${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (options.json) {
    return { output: JSON.stringify({ ok: true, entry: result.entry }) + '\n', exitCode: 0 };
  }

  const reasonText = result.entry?.reason ? ` ${c.dim}(reason: ${result.entry.reason})${c.reset}` : '';
  return {
    output: `${c.green}✓${c.reset} Recorded ${c.cyan}${phaseId}${c.reset}${reasonText}\n`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function validate(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(TRACKER_PATH)) {
    const msg =
      `${c.red}✗ Review phase tracker missing.${c.reset}\n` +
      `  Run \`crux sys review-phase init\` at the start of /agent-review-pr.\n`;
    if (options.json) {
      return { output: JSON.stringify({ ok: false, missing: PHASE_IDS, error: 'tracker missing' }) + '\n', exitCode: 2 };
    }
    return { output: msg, exitCode: 2 };
  }

  const result = validateTracker();

  if (options.json) {
    return {
      output:
        JSON.stringify({
          ok: result.ok,
          missing: result.missing,
          inSync: result.inSync,
          init: result.init,
          entries: result.entries,
        }) + '\n',
      exitCode: result.ok ? 0 : 2,
    };
  }

  const lines: string[] = [];
  for (const id of PHASE_IDS) {
    const entry = result.entries[id];
    if (entry?.reason) {
      lines.push(`  ${c.yellow}~${c.reset} ${id} ${c.dim}(${entry.timestamp}, skipped: ${entry.reason})${c.reset}`);
    } else if (entry) {
      lines.push(`  ${c.green}✓${c.reset} ${id} ${c.dim}(${entry.timestamp})${c.reset}`);
    } else {
      lines.push(`  ${c.red}✗${c.reset} ${id} ${c.red}(missing)${c.reset}`);
    }
  }

  let output = `${c.bold}Review Phase Coverage${c.reset}\n` + lines.join('\n') + '\n';

  if (!result.inSync && result.init) {
    output +=
      `\n${c.yellow}⚠ Tracker is out of sync with current branch state.${c.reset}\n` +
      `  ${c.dim}Tracker init:${c.reset} commit ${result.init.commitSha.slice(0, 12)}, diff ${result.init.diffHash}\n` +
      `  ${c.dim}Current:${c.reset}      commit ${getHeadSha().slice(0, 12)}, diff ${computeDiffHash()}\n` +
      `  Re-run \`crux sys review-phase init\` and re-record any phases that need to repeat.\n`;
  }

  if (!result.ok) {
    output += `\n${c.red}✗ ${result.missing.length} phase(s) missing — review marker cannot be written.${c.reset}\n`;
    return { output, exitCode: 2 };
  }

  output += `\n${c.green}✓ All ${PHASE_IDS.length} phases recorded.${c.reset}\n`;
  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// list (alias of validate, but always exit 0 for read-only inspection)
// ---------------------------------------------------------------------------

async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const result = await validate([], options);
  return { output: result.output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// summary — for PR body inclusion
// ---------------------------------------------------------------------------

async function summary(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const tracker = readTracker();
  const skippedSummary = summarizeSkipped(tracker);

  if (options.json) {
    const validation = validateTracker(tracker);
    return {
      output:
        JSON.stringify({
          phases: PHASE_IDS.map((id) => ({
            id,
            executed: validation.entries[id] !== null && !validation.entries[id]?.reason,
            skipped: validation.entries[id]?.reason ?? null,
            timestamp: validation.entries[id]?.timestamp ?? null,
          })),
          allComplete: validation.ok,
        }) + '\n',
      exitCode: 0,
    };
  }

  if (!skippedSummary) {
    return { output: '', exitCode: 0 };
  }
  return { output: skippedSummary + '\n', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// write-marker — the only sanctioned path to write .claude/review-done.
// Validates phase coverage first; refuses on any missing phase unless --force.
// ---------------------------------------------------------------------------

async function writeMarker(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(TRACKER_PATH)) {
    return {
      output:
        `${c.red}✗ Cannot write review marker — phase tracker missing.${c.reset}\n` +
        `  Run \`crux sys review-phase init\` then re-run /agent-review-pr from Phase 1.\n`,
      exitCode: 2,
    };
  }

  const result = validateTracker();
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';

  // The whole point of QUA-950 is that the marker write is gated on phase
  // coverage. --force is the only escape hatch but must NOT be a silent
  // bypass — same pattern as `pr.ts --skip-review-check`: require an
  // explicit justification, log it loudly, and fail-loud if missing.
  // Defended against by the hostile-reviewer pass before merge.
  if (options.force) {
    if (!reason) {
      return {
        output:
          `${c.red}✗ --force requires --reason="<text>".${c.reset}\n` +
          `  Bypassing phase coverage without a stated reason defeats the gate.\n` +
          `  Acceptable reasons: "patrol-fix: targeted change, full review unnecessary",\n` +
          `  "rebase: re-baselined diff, prior review still covers all changes", etc.\n`,
        exitCode: 1,
      };
    }
    if (/[\n\r]/.test(reason)) {
      return {
        output: `${c.red}✗ --reason must not contain newlines.${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  if (!result.ok && !options.force) {
    const missing = result.missing.join(', ');
    return {
      output:
        `${c.red}✗ Cannot write review marker — ${result.missing.length} phase(s) missing:${c.reset}\n` +
        `  ${missing}\n\n` +
        `  Each missing phase must be either executed (record without --reason)\n` +
        `  or explicitly skipped (record --reason="why this phase doesn't apply").\n\n` +
        `  Run \`crux sys review-phase validate\` for the full coverage table.\n`,
      exitCode: 2,
    };
  }

  if (!result.inSync && !options.force) {
    return {
      output:
        `${c.red}✗ Cannot write review marker — tracker is out of sync with HEAD.${c.reset}\n` +
        `  Either re-init and re-run any phases affected by the new commits,\n` +
        `  or pass --force --reason="..." if you've reviewed the new diff.\n`,
      exitCode: 2,
    };
  }

  // Snapshot HEAD/diff-hash AFTER the validation check so the marker
  // describes the same state validation just blessed. Avoids a TOCTOU
  // window where a commit lands between validateTracker and writeFileSync.
  const headSha = getHeadSha();
  const diffHash = computeDiffHash();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const line = `reviewed ${headSha} ${timestamp} ${diffHash}\n`;
  writeFileSync(MARKER_PATH, line, 'utf-8');

  // Append a force-bypass audit line to the tracker so the bypass is
  // visible in `crux sys review-phase validate` and via `summary --json`.
  if (options.force) {
    appendFileSync(
      TRACKER_PATH,
      `# force-bypass ${timestamp} reason=${reason}\n`,
      'utf-8',
    );
  }

  if (options.json) {
    return {
      output:
        JSON.stringify({
          ok: true,
          commitSha: headSha,
          diffHash,
          timestamp,
          marker: MARKER_PATH,
          forced: !!options.force,
          reason: options.force ? reason : undefined,
        }) + '\n',
      exitCode: 0,
    };
  }

  const skippedSummary = summarizeSkipped();
  let output = `${c.green}✓${c.reset} Review marker written at ${MARKER_PATH}\n`;
  output += `  ${c.dim}Commit:${c.reset}    ${headSha.slice(0, 12)}\n`;
  output += `  ${c.dim}Diff hash:${c.reset} ${diffHash}\n`;
  if (options.force) {
    output += `\n  ${c.yellow}⚠ Forced past phase coverage check.${c.reset}\n`;
    output += `  ${c.dim}Reason:${c.reset} ${reason}\n`;
  }
  if (skippedSummary) {
    output += `\n  ${c.dim}Phases skipped:${c.reset}\n`;
    for (const skipLine of skippedSummary.split('\n')) {
      output += `  ${skipLine}\n`;
    }
  }
  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// reset — wipe the tracker (for tests / manual recovery)
// ---------------------------------------------------------------------------

async function reset(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  if (existsSync(TRACKER_PATH)) {
    unlinkSync(TRACKER_PATH);
    return { output: `${c.green}✓${c.reset} Tracker removed: ${TRACKER_PATH}\n`, exitCode: 0 };
  }
  return { output: `${c.dim}Tracker not present — nothing to reset.${c.reset}\n`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: validate,
  init,
  record,
  validate,
  list,
  summary,
  'write-marker': writeMarker,
  reset,
};

export function getHelp(): string {
  return `
Review Phase Tracker — structural enforcement for /agent-review-pr phases

Commands:
  init                    Initialize tracker (Phase 1 of /agent-review-pr)
  record <phase-id>       Record phase execution (default: validate)
                          --reason="..."  mark phase as skipped with justification
                          (rejected for phase-1-triage / phase-2-mechanical / phase-9-final)
  validate                Check that every required phase has an entry (default)
  list                    Same as validate but exits 0 (read-only inspection)
  summary                 Print one-line skip summary for PR body
  write-marker            Validate + write .claude/review-done atomically
  reset                   Remove the tracker file

Required phase IDs (10 total):
  ${PHASE_IDS.join('\n  ')}

Examples:
  crux sys review-phase init
  crux sys review-phase record phase-1-triage
  crux sys review-phase record phase-7-ui --reason="N/A: no .tsx files changed"
  crux sys review-phase validate
  crux sys review-phase write-marker
`;
}
