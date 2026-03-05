/**
 * Agent Session Events Command Handlers — Activity timeline for agent sessions
 *
 * Usage:
 *   crux agent-session-events log "message" [--type=note] [--agent=ID]   Append an event
 *   crux agent-session-events list [--agent=ID] [--limit=50]             Show event timeline
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger } from '../lib/output.ts';
import {
  appendEvent,
  listEvents,
  type AgentEventEntry,
} from '../lib/wiki-server/agent-session-events.ts';
import { listActiveAgents } from '../lib/wiki-server/active-agents.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { execSync } from 'child_process';

interface CommandOptions extends BaseOptions {
  type?: string;
  agent?: string;
  limit?: string;
  json?: boolean;
  ci?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES = [
  'registered',
  'checklist_check',
  'status_update',
  'error',
  'note',
  'completed',
] as const;

type EventType = (typeof VALID_EVENT_TYPES)[number];

/** Get the current git branch name. */
function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Resolve agent ID: use --agent if provided, otherwise look up by current branch.
 */
async function resolveAgentId(options: CommandOptions): Promise<{ id: number } | { error: string }> {
  if (options.agent) {
    const id = Number(options.agent);
    if (!Number.isInteger(id) || id < 1) {
      return { error: `Invalid agent ID: ${options.agent}` };
    }
    return { id };
  }

  // Look up active agent by current branch
  const branch = currentBranch();
  if (!branch) {
    return { error: 'Not in a git repository and no --agent specified' };
  }

  const result = await listActiveAgents('active');
  if (!result.ok) {
    return { error: `Failed to list agents: ${result.message}` };
  }

  const agent = result.data.agents.find(a => a.sessionId === branch);
  if (!agent) {
    return { error: `No active agent found for branch "${branch}". Use --agent=ID to specify.` };
  }

  return { id: agent.id };
}

function formatEvent(e: AgentEventEntry, colors: ReturnType<typeof createLogger>['colors']): string {
  const ts = new Date(e.timestamp).toLocaleString();
  const typeColors: Record<string, string> = {
    registered: colors.green,
    checklist_check: colors.cyan,
    status_update: colors.yellow,
    error: colors.red,
    note: colors.dim,
    completed: colors.green,
  };
  const color = typeColors[e.eventType] ?? '';
  return `  ${colors.dim}${ts}${colors.reset}  ${color}[${e.eventType}]${colors.reset}  ${e.message}`;
}

async function checkServer(): Promise<CommandResult | null> {
  const available = await isServerAvailable();
  if (!available) {
    return { exitCode: 1, output: 'Error: Wiki server is not reachable' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// log — append an event
// ---------------------------------------------------------------------------

async function logCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const message = args.filter(a => !a.startsWith('--')).join(' ');
  if (!message) {
    return {
      exitCode: 1,
      output: `${c.red}Usage: crux agent-session-events log "message" [--type=note] [--agent=ID]${c.reset}

  Append an event to the agent's activity timeline.

Options:
  --type=TYPE    Event type: ${VALID_EVENT_TYPES.join(', ')} (default: note)
  --agent=ID     Agent ID (auto-detected from current branch if not set)`,
    };
  }

  const eventType = (options.type as EventType) || 'note';
  if (!VALID_EVENT_TYPES.includes(eventType)) {
    return {
      exitCode: 1,
      output: `${c.red}Invalid event type: ${eventType}. Valid types: ${VALID_EVENT_TYPES.join(', ')}${c.reset}`,
    };
  }

  const err = await checkServer();
  if (err) return err;

  const agentResult = await resolveAgentId(options);
  if ('error' in agentResult) {
    return { exitCode: 1, output: `${c.red}${agentResult.error}${c.reset}` };
  }

  const result = await appendEvent({
    agentId: agentResult.id,
    eventType,
    message,
  });

  if (!result.ok) {
    return { exitCode: 1, output: `${c.red}Error: ${result.message}${c.reset}` };
  }

  if (options.ci || options.json) {
    return { exitCode: 0, output: JSON.stringify(result.data) };
  }

  return {
    exitCode: 0,
    output: `${c.green}✓${c.reset} Event logged (agent #${agentResult.id}, type: ${eventType})`,
  };
}

// ---------------------------------------------------------------------------
// list — show event timeline
// ---------------------------------------------------------------------------

async function listCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const err = await checkServer();
  if (err) return err;

  const agentResult = await resolveAgentId(options);
  if ('error' in agentResult) {
    return { exitCode: 1, output: `${c.red}${agentResult.error}${c.reset}` };
  }

  const limit = Number(options.limit || 50);
  const result = await listEvents(agentResult.id, limit);

  if (!result.ok) {
    return { exitCode: 1, output: `${c.red}Error: ${result.message}${c.reset}` };
  }

  if (options.json) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  const { events } = result.data;

  if (events.length === 0) {
    return { exitCode: 0, output: `No events found for agent #${agentResult.id}.` };
  }

  // Show in chronological order (API returns newest-first)
  const chronological = [...events].reverse();

  let output = `${c.bold}Event Timeline — Agent #${agentResult.id}${c.reset} (${events.length} events)\n\n`;
  for (const event of chronological) {
    output += formatEvent(event, c) + '\n';
  }

  return { exitCode: 0, output: output.trimEnd() };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: listCommand,
  log: logCommand,
  list: listCommand,
};

export function getHelp(): string {
  return `
Agent Session Events Domain — Activity timeline for agent sessions

Track what agents do during their sessions: checklist checks, errors, notes, and more.

Commands:
  log "message"    Append an event to the agent's timeline (default type: note)
  list             Show the event timeline for an agent (default)

Options:
  --type=TYPE      Event type: registered, checklist_check, status_update, error, note, completed
  --agent=ID       Agent ID (auto-detected from current branch if not set)
  --limit=N        Number of events to show (default: 50)
  --json           JSON output
  --ci             CI-compatible output

Examples:
  crux agent-session-events log "Starting implementation of issue #42"
  crux agent-session-events log "Tests failing: 3 errors in auth module" --type=error
  crux agent-session-events list
  crux agent-session-events list --agent=7 --limit=100
`;
}
