/**
 * PR Patrol — Reflection system (periodic log analysis)
 */

import { existsSync, readFileSync } from 'fs';
import type { PatrolConfig } from './types.ts';
import { appendJsonl, JSONL_FILE, log, logHeader, REFLECTION_FILE } from './state.ts';
import { spawnClaude } from './execution.ts';

export async function runReflection(
  cycleCount: number,
  config: PatrolConfig,
): Promise<void> {
  logHeader(`Reflection (cycle #${cycleCount})`);

  if (!existsSync(JSONL_FILE)) {
    log('Skipping reflection — no log file yet');
    return;
  }

  const allEntries = readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
  if (allEntries.length < 10) {
    log(`Skipping reflection — only ${allEntries.length} log entries (need ≥10)`);
    return;
  }

  const recentEntries = allEntries.slice(-100).join('\n');

  const prompt = `You are a PR Patrol operations analyst for the ${config.repo} repository.
Your job is to review recent automated PR fix logs and identify actionable patterns that warrant filing a GitHub issue.

## Recent JSONL Log Entries

${recentEntries}

## Your Task

1. Analyze the logs for patterns:
   - PRs that repeatedly hit max-turns or error out (wasted compute)
   - Issue types that are never successfully fixed
   - PRs being re-processed for the same unfixable issues
   - High elapsed times suggesting the prompt needs improvement

2. If you find something actionable:
   a. First, search for an existing issue: pnpm crux issues search "your topic"
   b. If no duplicate exists, file exactly ONE issue:
      pnpm crux issues create "Title" --problem="Specific description with data from logs" --model=haiku --criteria="Fix applied|Tests pass" --label=pr-patrol
   c. If a duplicate exists, add a comment with your new data: pnpm crux issues comment <N> "new evidence"

3. If nothing actionable is found, just output: "No actionable patterns found"

## Constraints
- File AT MOST 1 issue.
- Issues must reference concrete data from the logs (PR numbers, counts, cycle numbers).
- Do NOT file speculative issues — only patterns demonstrated by log data.
- Do NOT file issues about one-time events — look for recurring patterns (3+ occurrences).
- Do NOT run any git commands or modify any files.
- Do NOT run /agent-session-start or /agent-session-ready-PR.`;

  const startTime = Date.now();
  try {
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: 10, // Reflection needs fewer turns
      model: 'haiku', // Reflection is log analysis — doesn't need sonnet
      timeoutMinutes: 5, // Should complete quickly
    });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut || result.hitMaxTurns) {
      const reason = result.timedOut ? 'timeout' : 'max-turns';
      appendJsonl(REFLECTION_FILE, {
        cycle_number: cycleCount,
        elapsed_s: elapsedS,
        filed_issue: false,
        exit_code: result.exitCode,
        outcome: 'incomplete',
        reason,
        summary: result.output.slice(-500),
      });
      log(
        `⚠ Reflection incomplete (${elapsedS}s, ${reason})`,
      );
    } else {
      const filedIssue = /Created issue #|created.*#\d/.test(result.output);
      appendJsonl(REFLECTION_FILE, {
        cycle_number: cycleCount,
        elapsed_s: elapsedS,
        filed_issue: filedIssue,
        exit_code: result.exitCode,
        outcome: 'complete',
        summary: result.output.slice(-500),
      });
      log(
        `✓ Reflection complete (${elapsedS}s, filed_issue=${filedIssue})`,
      );
    }
  } catch (e) {
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);
    log(
      `✗ Reflection failed (${elapsedS}s): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
