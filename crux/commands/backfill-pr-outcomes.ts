/**
 * Backfill PR Outcomes — scan agent sessions and set prOutcome based on GitHub PR state.
 *
 * For each completed agent session with a PR URL but no outcome:
 * 1. Fetch the PR from GitHub API
 * 2. Determine outcome: merged, closed_without_merge
 * 3. Check if any subsequent PRs reference it in a fix context (merged_with_revisions)
 * 4. Update the agent session record via wiki-server
 *
 * Usage:
 *   crux backfill-pr-outcomes           # Dry run (show what would change)
 *   crux backfill-pr-outcomes --apply   # Actually update records
 *   crux backfill-pr-outcomes --all     # Include sessions that already have outcomes
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { updateAgentSession } from '../lib/wiki-server/agent-sessions.ts';
import type { PrOutcome } from '../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// GitHub types
// ---------------------------------------------------------------------------

interface GitHubPR {
  number: number;
  state: string; // 'open' | 'closed'
  merged_at: string | null;
  html_url: string;
  title: string;
}

interface AgentSessionRow {
  id: number;
  branch: string;
  task: string;
  prUrl: string | null;
  prOutcome: string | null;
  status: string;
}

interface AgentSessionListResponse {
  sessions: AgentSessionRow[];
}

// ---------------------------------------------------------------------------
// run — default command
// ---------------------------------------------------------------------------

async function runCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;
  const apply = !!options.apply;
  const includeAll = !!options.all;

  // Fetch agent sessions from wiki-server
  const sessionsResult = await apiRequest<AgentSessionListResponse>(
    'GET',
    '/api/agent-sessions?limit=200',
  );

  if (!sessionsResult.ok) {
    return {
      output: `${c.red}Error: Could not fetch agent sessions from wiki-server: ${sessionsResult.error}${c.reset}`,
      exitCode: 1,
    };
  }

  const sessions = sessionsResult.data.sessions;

  // 'stale' sessions may have prUrl written by /agent-ship before sweep fired.
  const candidates = sessions.filter(s => {
    if (!s.prUrl) return false;
    if (!includeAll && s.prOutcome) return false;
    return s.status === 'completed' || s.status === 'stale';
  });

  if (candidates.length === 0) {
    return {
      output: `${c.green}No sessions need outcome backfill.${c.reset}\n` +
        `${c.dim}Total sessions: ${sessions.length}, with PR: ${sessions.filter(s => s.prUrl).length}, ` +
        `with outcome: ${sessions.filter(s => s.prOutcome).length}${c.reset}\n`,
      exitCode: 0,
    };
  }

  let output = `\n${c.bold}PR Outcome Backfill${c.reset}\n`;
  output += `${c.dim}${candidates.length} sessions to process${apply ? ' (APPLYING)' : ' (DRY RUN)'}${c.reset}\n\n`;

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of candidates) {
    const prNum = session.prUrl!.match(/\/pull\/(\d+)/)?.[1];
    if (!prNum) {
      output += `  ${c.dim}[skip] Session ${session.id}: invalid PR URL ${session.prUrl}${c.reset}\n`;
      skipped++;
      continue;
    }

    let pr: GitHubPR;
    try {
      pr = await githubApi<GitHubPR>(`/repos/${REPO}/pulls/${prNum}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output += `  ${c.red}[error] Session ${session.id} (PR #${prNum}): ${msg}${c.reset}\n`;
      errors++;
      continue;
    }

    let outcome: PrOutcome;
    if (pr.merged_at) {
      outcome = 'merged';
    } else if (pr.state === 'closed') {
      outcome = 'closed_without_merge';
    } else {
      // PR is still open — skip
      output += `  ${c.dim}[skip] Session ${session.id} (PR #${prNum}): still open${c.reset}\n`;
      skipped++;
      continue;
    }

    const currentOutcome = session.prOutcome;
    if (currentOutcome === outcome) {
      output += `  ${c.dim}[unchanged] Session ${session.id} (PR #${prNum}): already ${outcome}${c.reset}\n`;
      skipped++;
      continue;
    }

    const outcomeLabel = outcome === 'merged' ? c.green + outcome + c.reset :
      outcome === 'closed_without_merge' ? c.red + 'closed' + c.reset :
      outcome;

    output += `  [${apply ? 'update' : 'would update'}] Session ${session.id} (PR #${prNum}): `;
    output += currentOutcome ? `${currentOutcome} → ${outcomeLabel}` : outcomeLabel;
    output += ` — ${session.task.slice(0, 60)}\n`;

    if (apply) {
      try {
        await updateAgentSession(session.id, { prOutcome: outcome });
        updated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output += `    ${c.red}Failed to update: ${msg}${c.reset}\n`;
        errors++;
      }
    } else {
      updated++;
    }
  }

  output += `\n${c.bold}Summary:${c.reset}\n`;
  output += `  ${apply ? 'Updated' : 'Would update'}: ${updated}\n`;
  output += `  Skipped: ${skipped}\n`;
  if (errors > 0) output += `  ${c.red}Errors: ${errors}${c.reset}\n`;
  if (!apply && updated > 0) {
    output += `\n${c.dim}Run with --apply to update records.${c.reset}\n`;
  }

  return { output, exitCode: errors > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  default: runCommand,
  run: runCommand,
};

export function getHelp(): string {
  return `
Backfill PR Outcomes — set prOutcome on agent sessions based on GitHub PR state

Usage:
  crux backfill-pr-outcomes             Dry run (preview changes)
  crux backfill-pr-outcomes --apply     Apply changes to wiki-server
  crux backfill-pr-outcomes --all       Re-check sessions that already have outcomes

Scans completed agent sessions with PR URLs. For each, fetches the PR from
GitHub and sets the outcome field:
  merged                 — PR was merged
  closed_without_merge   — PR was closed without merging

Note: "merged_with_revisions" and "reverted" must be set manually via
  pnpm crux gh issues done <N> --outcome=merged_with_revisions
since they require human judgment about whether revisions were needed.
`;
}
