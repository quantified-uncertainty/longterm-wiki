/**
 * Agents Command Handlers — Live agent coordination
 *
 * Usage:
 *   crux sys agents register --task="..." [--branch=X] [--issue=N]   Register this agent
 *   crux sys agents status                                           Show all active agents
 *   crux sys agents update <id> [--step="..."] [--status=X]          Update agent state
 *   crux sys agents heartbeat <id>                                   Send heartbeat
 *   crux sys agents complete <id>                                    Mark agent as completed
 *   crux sys agents close [--reason="..."]                           Close current session (auto-discovers agent)
 *   crux sys agents sweep [--timeout=30]                             Mark stale agents
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { gitSafe } from '../lib/git.ts';
import {
  registerAgent,
  listActiveAgents,
  updateAgent,
  heartbeat,
  sweepStaleAgents,
  type ActiveAgentEntry,
  type ActiveAgentListResponse,
} from '../lib/wiki-server/active-agents.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { sweepStaleSessions, getAgentSessionByBranch, updateAgentSession } from '../lib/wiki-server/agent-sessions.ts';
import { appendEvent } from '../lib/wiki-server/agent-session-events.ts';
import { buildCloseUpdates } from '../lib/session/session-sync-payload.ts';
import { parseLinearId } from '../lib/linear/parse-id.ts';
import { getIssueStates } from '../lib/linear/issue-states-cache.ts';

interface CommandOptions extends BaseOptions {
  task?: string;
  branch?: string;
  issue?: string;
  model?: string;
  worktree?: string;
  step?: string;
  status?: string;
  pr?: string;
  files?: string;
  timeout?: string;
  limit?: string;
  reason?: string;
  json?: boolean;
  ci?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentAnnotation {
  linearId: string | null;
  linearState: string | null;
}

function formatAgent(
  a: ActiveAgentEntry,
  colors: ReturnType<typeof createLogger>['colors'],
  annotation: AgentAnnotation = { linearId: null, linearState: null },
): string {
  const statusColors: Record<string, string> = {
    active: colors.green,
    completed: colors.dim,
    errored: colors.red,
    stale: colors.yellow,
  };
  const statusColor = statusColors[a.status] ?? '';
  const heartbeat = a.heartbeatAt ? new Date(a.heartbeatAt).toLocaleTimeString() : '—';
  const started = new Date(a.startedAt).toLocaleString();
  const issue = a.issueNumber ? ` #${a.issueNumber}` : '';
  const pr = a.prNumber ? ` PR#${a.prNumber}` : '';
  const step = a.currentStep ? `\n    Step: ${a.currentStep}` : '';
  const files = a.filesTouched?.length ? `\n    Files: ${a.filesTouched.slice(0, 5).join(', ')}${a.filesTouched.length > 5 ? ` (+${a.filesTouched.length - 5} more)` : ''}` : '';

  const name = a.sessionName ? ` ${colors.cyan}${a.sessionName}${colors.reset}` : '';
  const worktreeInfo = a.worktree ? `    Dir: ${colors.dim}${a.worktree}${colors.reset}` : '';
  const linearLine = annotation.linearId
    ? `    Linear: ${colors.cyan}${annotation.linearId}${colors.reset} ${annotation.linearState ?? '—'}`
    : '    Linear: —';

  return [
    `  ${colors.bold}#${a.id}${colors.reset}${name} ${statusColor}[${a.status}]${colors.reset}${issue}${pr}`,
    `    ${a.task}`,
    a.branch ? `    Branch: ${colors.dim}${a.branch}${colors.reset}` : '',
    worktreeInfo,
    a.model ? `    Model: ${a.model}` : '',
    linearLine,
    `    Started: ${started}  Heartbeat: ${heartbeat}`,
    step,
    files,
  ].filter(Boolean).join('\n');
}

/**
 * Map each agent's id to its Linear ticket identifier (or `null` if none
 * is detectable). Prefers the server-provided `linearId` from the
 * authoritative `agent_sessions` row over branch-name parsing, so that
 * agents registered without a session (job workers, ad-hoc registrations)
 * still get a best-effort match from the branch.
 *
 * Exported for tests.
 */
export function collectLinearIds(
  agents: readonly ActiveAgentEntry[],
): Map<number, string | null> {
  const linearIds = new Map<number, string | null>();
  for (const agent of agents) {
    linearIds.set(agent.id, agent.linearId ?? parseLinearId(agent.branch));
  }
  return linearIds;
}

async function checkServer(): Promise<CommandResult | null> {
  const available = await isServerAvailable();
  if (!available) {
    return { exitCode: 1, output: 'Error: Wiki server is not reachable' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

async function registerCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  if (!options.task) {
    return {
      exitCode: 1,
      output: `Usage: crux sys agents register --task="description" [--branch=X] [--issue=N] [--model=X]

  Register this agent session with the coordination server.
  Returns the agent ID for subsequent updates.

Options:
  --task="..."     What the agent is working on (required)
  --branch=X       Git branch name
  --issue=N        GitHub issue number
  --model=X        Claude model being used
  --worktree=X     Worktree path if in isolated mode`,
    };
  }

  const err = await checkServer();
  if (err) return err;

  // Use branch as sessionId if available, otherwise generate one
  const sessionId = options.branch || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const result = await registerAgent({
    sessionId,
    branch: options.branch ?? null,
    task: options.task,
    issueNumber: options.issue ? Number(options.issue) : null,
    model: options.model ?? null,
    worktree: options.worktree ?? null,
  });

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci || options.json) {
    return { exitCode: 0, output: JSON.stringify(result.data) };
  }

  const nameTag = result.data.sessionName ? ` \x1b[36m${result.data.sessionName}\x1b[0m` : '';
  return {
    exitCode: 0,
    output: `\x1b[32m✓\x1b[0m Registered agent #${result.data.id}${nameTag} (session: ${result.data.sessionId})`,
  };
}

// ---------------------------------------------------------------------------
// status (list active agents)
// ---------------------------------------------------------------------------

async function statusCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const err = await checkServer();
  if (err) return err;

  const log = createLogger(options.ci);
  const limit = Number(options.limit || 50);
  const statusFilter = options.status || 'active';

  const result = await listActiveAgents(statusFilter, limit);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  const { agents, conflicts, directoryConflicts } = result.data;

  const linearIds = collectLinearIds(agents);
  const uniqueIds = [...new Set([...linearIds.values()].filter((id): id is string => id !== null))];
  const states = await getIssueStates(uniqueIds);

  const annotationFor = (agent: ActiveAgentEntry): AgentAnnotation => {
    const linearId = linearIds.get(agent.id) ?? null;
    return {
      linearId,
      linearState: linearId ? states.get(linearId) ?? null : null,
    };
  };

  if (options.json) {
    const enriched = {
      ...result.data,
      agents: agents.map((a) => ({ ...a, ...annotationFor(a) })),
    };
    return { exitCode: 0, output: JSON.stringify(enriched, null, 2) };
  }

  if (agents.length === 0) {
    return { exitCode: 0, output: `No ${statusFilter} agents found.` };
  }

  let output = `${log.colors.bold}Active Agents (${agents.length})${log.colors.reset}\n\n`;
  for (const agent of agents) {
    output += formatAgent(agent, log.colors, annotationFor(agent)) + '\n\n';
  }

  if (conflicts.length > 0) {
    output += `${log.colors.red}${log.colors.bold}⚠ Issue conflicts:${log.colors.reset}\n`;
    for (const c of conflicts) {
      output += `  Issue #${c.issueNumber}: ${c.sessionIds.length} agents working on it\n`;
      for (const sid of c.sessionIds) {
        output += `    - ${sid}\n`;
      }
    }
  }

  if (directoryConflicts && directoryConflicts.length > 0) {
    output += `${log.colors.yellow}${log.colors.bold}⚠ Directory conflicts:${log.colors.reset}\n`;
    for (const dc of directoryConflicts) {
      output += `  ${dc.directory}: ${dc.sessionIds.length} agents in same directory\n`;
      for (const sid of dc.sessionIds) {
        output += `    - ${sid}\n`;
      }
    }
  }

  return { exitCode: 0, output: output.trimEnd() };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function updateCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const idStr = args.find(a => !a.startsWith('--'));
  if (!idStr) {
    return {
      exitCode: 1,
      output: `Usage: crux sys agents update <id> [--step="..."] [--status=X] [--pr=N] [--files=a.ts,b.ts]

  Update the agent's current state. Any update also refreshes the heartbeat.

Options:
  --step="..."     What the agent is currently doing
  --status=X       active | completed | errored
  --pr=N           PR number
  --branch=X       Git branch
  --issue=N        GitHub issue number
  --files=a,b,c    Comma-separated list of files touched`,
    };
  }

  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) {
    return { exitCode: 1, output: 'Error: Agent ID must be a positive integer' };
  }

  const err = await checkServer();
  if (err) return err;

  const updates: Record<string, unknown> = {};
  if (options.step !== undefined) updates.currentStep = options.step;
  if (options.status !== undefined) updates.status = options.status;
  if (options.pr !== undefined) updates.prNumber = Number(options.pr);
  if (options.branch !== undefined) updates.branch = options.branch;
  if (options.issue !== undefined) updates.issueNumber = Number(options.issue);
  if (options.files !== undefined) updates.filesTouched = options.files.split(',').map(f => f.trim());

  const result = await updateAgent(id, updates);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci || options.json) {
    return { exitCode: 0, output: JSON.stringify(result.data) };
  }

  return {
    exitCode: 0,
    output: `\x1b[32m✓\x1b[0m Updated agent #${id}`,
  };
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

async function heartbeatCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const idStr = args.find(a => !a.startsWith('--'));
  if (!idStr) {
    return { exitCode: 1, output: 'Usage: crux sys agents heartbeat <id>' };
  }

  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) {
    return { exitCode: 1, output: 'Error: Agent ID must be a positive integer' };
  }

  const err = await checkServer();
  if (err) return err;

  const result = await heartbeat(id);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  return { exitCode: 0, output: `\x1b[32m✓\x1b[0m Heartbeat sent for agent #${id}` };
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

async function completeCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const idStr = args.find(a => !a.startsWith('--'));
  if (!idStr) {
    return { exitCode: 1, output: 'Usage: crux sys agents complete <id> [--pr=N]' };
  }

  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) {
    return { exitCode: 1, output: 'Error: Agent ID must be a positive integer' };
  }

  const err = await checkServer();
  if (err) return err;

  const updates: Record<string, unknown> = { status: 'completed' };
  if (options.pr !== undefined) updates.prNumber = Number(options.pr);

  const result = await updateAgent(id, updates);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  return { exitCode: 0, output: `\x1b[32m✓\x1b[0m Agent #${id} marked as completed` };
}

// ---------------------------------------------------------------------------
// close — auto-discover agent from local state and close everything
// ---------------------------------------------------------------------------

async function closeCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const agentIdPath = join(PROJECT_ROOT, '.claude/agent-id');
  const checklistPath = join(PROJECT_ROOT, '.claude/wip-checklist.md');
  const agentTaskPath = join(PROJECT_ROOT, '.agent-task');
  const lastHeartbeatPath = join(PROJECT_ROOT, '.claude/last-heartbeat');

  let output = '';
  let agentId: number | null = null;

  // 1. Read agent ID from local file
  if (existsSync(agentIdPath)) {
    const raw = readFileSync(agentIdPath, 'utf-8').trim();
    agentId = Number(raw);
    if (!Number.isInteger(agentId) || agentId < 1) {
      agentId = null;
      output += `${c.yellow}⚠ Invalid agent ID in .claude/agent-id: ${raw}${c.reset}\n`;
    }
  }

  // Check server availability once for all DB operations
  const serverUp = await isServerAvailable();
  const branchResult = gitSafe('rev-parse', '--abbrev-ref', 'HEAD');
  const branch = options.branch || (branchResult.ok ? branchResult.output : null);

  if (serverUp) {
    // 2 & 3. Fire independent DB calls in parallel
    const reason = options.reason ?? 'Session closed via crux sys agents close';

    const agentClosePromise = agentId
      ? Promise.allSettled([
          updateAgent(agentId, { status: 'completed' }),
          appendEvent({ agentId, eventType: 'completed', message: reason }),
        ])
      : null;

    const closeable = branch && branch !== 'main' && branch !== 'detached';
    const sessionClosePromise = closeable
      ? getAgentSessionByBranch(branch).catch(() => null)
      : null;
    // Speculatively kick off the close-time PATCH payload build —
    // it overlaps the GitHub PR lookup with the parallel DB calls
    // above instead of running serialized after them. The cost of a
    // wasted lookup when sessionResult ends up missing is one HTTP
    // call; the save is 100-500 ms when it lands. We capture the
    // build error rather than swallowing it so the consumer below can
    // surface it — silently falling back to `{status:'completed'}`
    // would re-introduce the QUA-1073 NULL-writeback failure mode.
    let closeUpdatesError: Error | null = null;
    const closeUpdatesPromise = closeable
      ? buildCloseUpdates({ branch }).catch((e: unknown) => {
          closeUpdatesError = e instanceof Error ? e : new Error(String(e));
          return null;
        })
      : null;

    const [agentResults, sessionResult, closeUpdates] = await Promise.all([
      agentClosePromise,
      sessionClosePromise,
      closeUpdatesPromise,
    ]);

    // Process agent close results
    if (agentId && agentResults) {
      const [agentUpdate, eventLog] = agentResults;
      if (agentUpdate.status === 'fulfilled' && agentUpdate.value.ok) {
        output += `${c.green}✓${c.reset} Active agent #${agentId} marked completed\n`;
      } else {
        const msg = agentUpdate.status === 'rejected'
          ? (agentUpdate.reason instanceof Error ? agentUpdate.reason.message : String(agentUpdate.reason))
          : (agentUpdate.value as { message?: string }).message ?? 'unknown error';
        output += `${c.yellow}⚠ Failed to close active agent #${agentId}: ${msg}${c.reset}\n`;
      }
      if (eventLog.status === 'rejected') {
        output += `${c.dim}  (event log failed: ${eventLog.reason instanceof Error ? eventLog.reason.message : String(eventLog.reason)})${c.reset}\n`;
      }
    } else if (!agentId) {
      output += `${c.dim}No .claude/agent-id found — no active agent to close${c.reset}\n`;
    }

    // QUA-1073: PATCH carries `checksYaml`, `reviewed`, and `prUrl`
    // alongside `status` so completed rows stop landing with all three
    // NULL. If the speculative build threw, surface that and fall
    // back to status-only — the row at least leaves `active`, but
    // the operator sees why the close-time fields didn't sync.
    if (sessionResult && 'ok' in sessionResult && sessionResult.ok && sessionResult.data.status === 'active') {
      try {
        if (closeUpdatesError) {
          output += `${c.yellow}⚠ Failed to build close-time payload (QUA-1073 fields will be NULL): ${closeUpdatesError.message}${c.reset}\n`;
        }
        const updates = closeUpdates ?? { status: 'completed' as const };
        await updateAgentSession(sessionResult.data.id, updates);
        output += `${c.green}✓${c.reset} Agent session for ${c.cyan}${branch}${c.reset} marked completed\n`;
      } catch (e: unknown) {
        output += `${c.dim}  (session close failed: ${e instanceof Error ? e.message : String(e)})${c.reset}\n`;
      }
    }
  } else {
    output += agentId
      ? `${c.yellow}⚠ Wiki server unreachable — skipping DB close${c.reset}\n`
      : `${c.dim}No .claude/agent-id found — no active agent to close${c.reset}\n`;
  }

  // 4. Clean up local files
  const cleaned: string[] = [];
  for (const [path, label] of [
    [agentIdPath, '.claude/agent-id'],
    [checklistPath, '.claude/wip-checklist.md'],
    [agentTaskPath, '.agent-task'],
    [lastHeartbeatPath, '.claude/last-heartbeat'],
  ] as const) {
    try {
      unlinkSync(path);
      cleaned.push(label);
    } catch {
      // File doesn't exist — nothing to clean
    }
  }
  if (cleaned.length > 0) {
    output += `${c.green}✓${c.reset} Cleaned up: ${cleaned.join(', ')}\n`;
  } else {
    output += `${c.dim}No local files to clean up${c.reset}\n`;
  }

  return { exitCode: 0, output };
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

async function sweepCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const err = await checkServer();
  if (err) return err;

  const timeout = Number(options.timeout || 30);
  let output = '';

  // Sweep active agents (stale after timeout minutes)
  const agentResult = await sweepStaleAgents(timeout);
  if (agentResult.ok) {
    if (agentResult.data.swept > 0) {
      output += `Active agents (E1281): swept ${agentResult.data.swept} stale agent(s):\n`;
      for (const a of agentResult.data.agents) {
        output += `  #${a.id} (${a.sessionId})\n`;
      }
    } else {
      output += 'Active agents (E1281): no stale agents.\n';
    }
  } else {
    output += `Active agents (E1281): Error: ${agentResult.message}\n`;
  }

  // Sweep agent sessions (stale after 2 hours)
  const sessionResult = await sweepStaleSessions(2);
  if (sessionResult.ok) {
    if (sessionResult.data.swept > 0) {
      output += `Agent sessions (E1281): swept ${sessionResult.data.swept} stale session(s):\n`;
      for (const s of sessionResult.data.sessions) {
        output += `  #${s.id} (${s.branch})\n`;
      }
    } else {
      output += 'Agent sessions (E1281): no stale sessions.\n';
    }
  } else {
    output += `Agent sessions (E1281): Error: ${sessionResult.message}\n`;
  }

  return { exitCode: 0, output };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: statusCommand,
  register: registerCommand,
  status: statusCommand,
  update: updateCommand,
  heartbeat: heartbeatCommand,
  complete: completeCommand,
  close: closeCommand,
  sweep: sweepCommand,
};

export function getHelp(): string {
  return `
Agents Domain — Live agent coordination

Track active Claude Code agents to prevent duplicate work and detect conflicts.

Commands:
  register    Register this agent with the coordination server
  status      Show all active agents and detect conflicts (default)
  update      Update agent state (step, files, status)
  heartbeat   Send a heartbeat to prove the agent is alive
  complete    Mark agent as completed (by ID)
  close       Close current session — auto-discovers agent, marks DB completed, cleans up local files
  sweep       Mark stale agents (no heartbeat for N minutes)

Options:
  --task="..."     Task description (register)
  --branch=X       Git branch (register, update)
  --issue=N        GitHub issue number (register, update)
  --model=X        Claude model (register)
  --step="..."     Current step description (update)
  --status=X       Filter or set: active | completed | errored | stale
  --pr=N           PR number (update, complete)
  --files=a,b,c    Comma-separated files touched (update)
  --reason="..."   Close reason (close)
  --timeout=30     Stale timeout in minutes (sweep)
  --json           JSON output
  --ci             CI-compatible output

Examples:
  crux sys agents register --task="Fix escaping bug" --branch=claude/fix-escaping --issue=42
  crux sys agents status
  crux sys agents update 7 --step="Running tests" --files=src/app.ts,src/lib/utils.ts
  crux sys agents heartbeat 7
  crux sys agents complete 7 --pr=123
  crux sys agents close                    # Close current session (auto-discovers agent)
  crux sys agents close --reason="shipped" # Close with a reason
  crux sys agents sweep --timeout=60
`;
}
