/**
 * Session Finalize — parse a Claude Code JSONL transcript and PATCH the agent session.
 *
 * Called automatically by the SessionEnd hook. Can also be run manually:
 *
 * Usage:
 *   crux sys session-finalize                     Auto-detect latest transcript + session
 *   crux sys session-finalize --session-id=N      Explicit session ID
 *   crux sys session-finalize --transcript=PATH   Explicit transcript file
 *   crux sys session-finalize --dry-run           Parse only, don't PATCH
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger } from '../lib/output.ts';
import { parseTranscript, findLatestTranscript } from '../lib/transcript-parser.ts';
import { getAgentSessionByBranch, updateAgentSession } from '../lib/wiki-server/agent-sessions.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { execSync } from 'child_process';

interface CommandOptions extends BaseOptions {
  sessionId?: string;
  transcript?: string;
  dryRun?: boolean;
  ci?: boolean;
  json?: boolean;
}

/** Get the current git branch name. */
function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/** Get the project root directory. */
function getProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

async function finalizeCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // 1. Find the transcript file
  let transcriptPath = options.transcript ?? null;

  if (!transcriptPath) {
    const projectRoot = getProjectRoot();
    transcriptPath = findLatestTranscript(projectRoot);

    if (!transcriptPath) {
      return {
        exitCode: 1,
        output: `${c.red}No JSONL transcript found for project: ${projectRoot}${c.reset}\n` +
          `${c.dim}Claude Code stores transcripts at ~/.claude/projects/<slug>/<sessionId>.jsonl${c.reset}`,
      };
    }
  }

  log.info(`${c.dim}Transcript: ${transcriptPath}${c.reset}`);

  // 2. Parse the transcript
  const result = parseTranscript(transcriptPath);

  if (result.lineCount === 0) {
    return {
      exitCode: 0,
      output: `${c.yellow}Empty transcript (0 lines) — nothing to finalize.${c.reset}`,
    };
  }

  if (options.json || options.dryRun) {
    const output = JSON.stringify({
      sessionId: result.sessionId,
      title: result.title,
      summary: result.summary?.slice(0, 500),
      model: result.model,
      durationMinutes: result.durationMinutes,
      branch: result.branch,
      lineCount: result.lineCount,
    }, null, 2);

    if (options.dryRun) {
      return {
        exitCode: 0,
        output: `${c.bold}Dry run — would PATCH with:${c.reset}\n${output}`,
      };
    }

    return { exitCode: 0, output };
  }

  // 3. Check wiki-server availability
  const available = await isServerAvailable();
  if (!available) {
    // Non-fatal: SessionEnd hook should not block session exit
    return {
      exitCode: 0,
      output: `${c.yellow}Wiki server not reachable — skipping session finalize.${c.reset}\n` +
        `${c.dim}Parsed: ${result.durationMinutes ?? '?'}min, model=${result.model ?? 'unknown'}${c.reset}`,
    };
  }

  // 4. Resolve the agent session ID
  let agentSessionId: number | null = null;

  if (options.sessionId) {
    agentSessionId = Number(options.sessionId);
    if (!Number.isInteger(agentSessionId) || agentSessionId < 1) {
      return { exitCode: 1, output: `${c.red}Invalid session ID: ${options.sessionId}${c.reset}` };
    }
  } else {
    // Try to find session by branch
    const branch = result.branch || currentBranch();
    if (!branch || branch === 'main' || branch === 'detached') {
      return {
        exitCode: 0,
        output: `${c.yellow}No feature branch detected — skipping session finalize.${c.reset}\n` +
          `${c.dim}Parsed: ${result.durationMinutes ?? '?'}min${c.reset}`,
      };
    }

    const sessionResult = await getAgentSessionByBranch(branch);
    if (!sessionResult.ok) {
      return {
        exitCode: 0,
        output: `${c.yellow}No agent session found for branch "${branch}" — skipping.${c.reset}\n` +
          `${c.dim}Parsed: ${result.durationMinutes ?? '?'}min${c.reset}`,
      };
    }

    agentSessionId = sessionResult.data.id;
  }

  // 5. Build the PATCH payload
  const updates: Record<string, unknown> = {};

  if (result.title) updates.title = result.title;
  if (result.summary) updates.summary = result.summary;
  if (result.model) updates.model = result.model;
  if (result.durationMinutes !== null) {
    updates.durationMinutes = result.durationMinutes;
    // Also produce a human-readable duration string
    if (result.durationMinutes < 60) {
      updates.duration = `~${result.durationMinutes} minutes`;
    } else {
      const hours = Math.floor(result.durationMinutes / 60);
      const mins = result.durationMinutes % 60;
      updates.duration = mins > 0 ? `~${hours}h ${mins}m` : `~${hours} hours`;
    }
  }
  if (result.startedAt) updates.date = result.startedAt.slice(0, 10); // YYYY-MM-DD

  // QUA-1073: Mark status='completed' alongside title+summary. The
  // earlier comment ("agent-ship/agent-end skill's job") was wrong:
  // those skills run BEFORE SessionEnd fires, so by the time they
  // call `updateAgentSession({status:'completed'})` the endpoint
  // hard-fail validation rejects the PATCH because title+summary
  // aren't set yet — leaving the row stuck in 'active'/'stale'.
  // session-finalize is the right place because (a) it runs at
  // session end, (b) it populates the title+summary the validation
  // requires, and (c) it sees them in the same atomic UPDATE so
  // validation succeeds.
  if (result.title && result.summary) {
    updates.status = 'completed';
  }

  if (Object.keys(updates).length === 0) {
    return {
      exitCode: 0,
      output: `${c.yellow}No metadata to update — transcript had no extractable data.${c.reset}`,
    };
  }

  // 6. PATCH the session
  const patchResult = await updateAgentSession(agentSessionId, updates as any);

  if (!patchResult.ok) {
    return {
      exitCode: 1,
      output: `${c.red}Failed to update session #${agentSessionId}: ${patchResult.message}${c.reset}`,
    };
  }

  const lines = [
    `${c.green}✓${c.reset} Session #${agentSessionId} finalized`,
    `  Model: ${result.model ?? 'unknown'}`,
    `  Duration: ${result.durationMinutes ?? '?'} min`,
  ];
  if (result.title) lines.push(`  Title: ${result.title.slice(0, 80)}`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: finalizeCommand,
};

export function getHelp(): string {
  return `
Session Finalize — parse JSONL transcript and PATCH agent session metadata

Extracts title, summary, model, and duration from the Claude Code
session transcript and writes them to the agent_sessions database.

Usage:
  crux sys session-finalize                     Auto-detect latest transcript
  crux sys session-finalize --session-id=42     Explicit session ID
  crux sys session-finalize --transcript=PATH   Explicit transcript file
  crux sys session-finalize --dry-run           Parse only, don't PATCH

Options:
  --session-id=N       Agent session ID to update (auto-detected from branch)
  --transcript=PATH    Path to .jsonl transcript file (auto-detected from project)
  --dry-run            Show parsed data without updating the database
  --json               JSON output
  --ci                 CI-compatible output
`;
}
