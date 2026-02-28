/**
 * Agents Command Handlers — Live agent coordination
 *
 * Usage:
 *   crux agents register --task="..." [--branch=X] [--issue=N]   Register this agent
 *   crux agents status                                           Show all active agents
 *   crux agents update <id> [--step="..."] [--status=X]          Update agent state
 *   crux agents heartbeat <id>                                   Send heartbeat
 *   crux agents complete <id>                                    Mark agent as completed
 *   crux agents sweep [--timeout=30]                             Mark stale agents
 */

import type { CommandResult } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import {
  registerAgent,
  listActiveAgents,
  updateAgent,
  heartbeat,
  sweepStaleAgents,
  type ActiveAgentEntry,
} from '../lib/wiki-server/active-agents.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';

interface CommandOptions {
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
  json?: boolean;
  ci?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAgent(a: ActiveAgentEntry, colors: ReturnType<typeof createLogger>['colors']): string {
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

  return [
    `  ${colors.bold}#${a.id}${colors.reset} ${statusColor}[${a.status}]${colors.reset}${issue}${pr}`,
    `    ${a.task}`,
    a.branch ? `    Branch: ${colors.dim}${a.branch}${colors.reset}` : '',
    a.model ? `    Model: ${a.model}` : '',
    `    Started: ${started}  Heartbeat: ${heartbeat}`,
    step,
    files,
  ].filter(Boolean).join('\n');
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
      output: `Usage: crux agents register --task="description" [--branch=X] [--issue=N] [--model=X]

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

  return {
    exitCode: 0,
    output: `\x1b[32m✓\x1b[0m Registered agent #${result.data.id} (session: ${result.data.sessionId})`,
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

  if (options.json) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { agents, conflicts } = result.data;

  if (agents.length === 0) {
    return { exitCode: 0, output: `No ${statusFilter} agents found.` };
  }

  let output = `${log.colors.bold}Active Agents (${agents.length})${log.colors.reset}\n\n`;
  for (const agent of agents) {
    output += formatAgent(agent, log.colors) + '\n\n';
  }

  if (conflicts.length > 0) {
    output += `${log.colors.red}${log.colors.bold}⚠ Conflicts detected:${log.colors.reset}\n`;
    for (const c of conflicts) {
      output += `  Issue #${c.issueNumber}: ${c.sessionIds.length} agents working on it\n`;
      for (const sid of c.sessionIds) {
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
      output: `Usage: crux agents update <id> [--step="..."] [--status=X] [--pr=N] [--files=a.ts,b.ts]

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
    return { exitCode: 1, output: 'Usage: crux agents heartbeat <id>' };
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
    return { exitCode: 1, output: 'Usage: crux agents complete <id> [--pr=N]' };
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
// sweep
// ---------------------------------------------------------------------------

async function sweepCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const err = await checkServer();
  if (err) return err;

  const timeout = Number(options.timeout || 30);
  const result = await sweepStaleAgents(timeout);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (result.data.swept === 0) {
    return { exitCode: 0, output: 'No stale agents found.' };
  }

  let output = `Swept ${result.data.swept} stale agent(s):\n`;
  for (const a of result.data.agents) {
    output += `  #${a.id} (${a.sessionId})\n`;
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
  complete    Mark agent as completed
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
  --timeout=30     Stale timeout in minutes (sweep)
  --json           JSON output
  --ci             CI-compatible output

Examples:
  crux agents register --task="Fix escaping bug" --branch=claude/fix-escaping --issue=42
  crux agents status
  crux agents update 7 --step="Running tests" --files=src/app.ts,src/lib/utils.ts
  crux agents heartbeat 7
  crux agents complete 7 --pr=123
  crux agents sweep --timeout=60
`;
}
