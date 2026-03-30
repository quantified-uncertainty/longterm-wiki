/**
 * Agent Reset — Find and clean stale processes left by Claude Code sessions
 *
 * Detects orphaned MCP servers, dev servers, test runners, and other Node
 * processes spawned by agent sessions that weren't cleaned up on exit.
 *
 * Usage:
 *   crux sys agent-reset                      Show stale processes (dry run)
 *   crux sys agent-reset --kill               Kill all detected stale processes
 *   crux sys agent-reset --kill --force       Kill without age threshold
 */

import { execSync } from 'child_process';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger } from '../lib/output.ts';

interface CommandOptions extends BaseOptions {
  kill?: boolean;
  force?: boolean;
  ci?: boolean;
  json?: boolean;
}

interface DetectedProcess {
  pid: number;
  category: string;
  description: string;
  cpuPercent: number;
  memMB: number;
  ageMinutes: number;
  command: string;
}

// Minimum age (minutes) before a process is considered stale.
// --force bypasses this.
const STALE_THRESHOLDS: Record<string, number> = {
  'mcp-server': 0, // MCP servers from dead sessions are always stale
  'dev-server': 120, // 2 hours
  'test-runner': 30, // 30 minutes
  'build-data': 60, // 1 hour
};

/**
 * Parse `ps` output into structured process records.
 * ps format: pid, %cpu, rss (KB), etime (elapsed), full command
 */
function parseProcesses(psOutput: string): Array<{
  pid: number;
  cpu: number;
  memKB: number;
  ageMinutes: number;
  command: string;
}> {
  const lines = psOutput.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    // Format: "  PID  %CPU   RSS      ELAPSED COMMAND..."
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    const [, pidStr, cpuStr, rssStr, elapsed, command] = match;
    return {
      pid: Number(pidStr),
      cpu: Number(cpuStr),
      memKB: Number(rssStr),
      ageMinutes: parseElapsed(elapsed),
      command,
    };
  }).filter((p): p is NonNullable<typeof p> => p !== null);
}

/**
 * Parse ps `etime` format into minutes.
 * Formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS"
 */
function parseElapsed(etime: string): number {
  const parts = etime.replace(/-/g, ':').split(':').map(Number);
  if (parts.length === 2) {
    // MM:SS
    return parts[0] + parts[1] / 60;
  } else if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 60 + parts[1] + parts[2] / 60;
  } else if (parts.length === 4) {
    // D:HH:MM:SS (days-hours:min:sec)
    return parts[0] * 1440 + parts[1] * 60 + parts[2] + parts[3] / 60;
  }
  return 0;
}

/**
 * Classify a process and return a DetectedProcess if it's a known agent artifact.
 * Returns null for processes that shouldn't be touched.
 */
function classifyProcess(
  proc: { pid: number; cpu: number; memKB: number; ageMinutes: number; command: string },
  myPid: number,
): DetectedProcess | null {
  const { pid, cpu, memKB, ageMinutes, command } = proc;

  // Never kill ourselves
  if (pid === myPid || pid === process.ppid) return null;

  // Playwright MCP servers
  if (command.includes('playwright-mcp')) {
    return {
      pid, category: 'mcp-server',
      description: 'Playwright MCP server',
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  // Puppeteer MCP servers
  if (command.includes('mcp-server-puppeteer')) {
    return {
      pid, category: 'mcp-server',
      description: 'Puppeteer MCP server',
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  // Filesystem MCP servers
  if (command.includes('mcp-server-filesystem')) {
    return {
      pid, category: 'mcp-server',
      description: 'Filesystem MCP server',
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  // Other MCP servers (generic pattern)
  if (command.includes('/mcp-server-') || command.includes('/mcp-')) {
    // Don't match if it's just "mcp" in a random path
    if (/\bmcp-server-\w+/.test(command) || /\/mcp-[a-z]+-/.test(command)) {
      return {
        pid, category: 'mcp-server',
        description: 'MCP server',
        cpuPercent: cpu, memMB: Math.round(memKB / 1024),
        ageMinutes, command,
      };
    }
  }

  // Next.js dev servers from agent slots (lw/a1..a15)
  if (command.includes('next dev') && /\/lw\/a\d+\//.test(command)) {
    const slotMatch = command.match(/\/lw\/a(\d+)\//);
    const slot = slotMatch ? slotMatch[1] : '?';
    return {
      pid, category: 'dev-server',
      description: `Next.js dev server (slot a${slot})`,
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  // next-server process (the actual Next.js server child)
  // Only match if it's clearly from an agent slot
  if (command.includes('next-server') && /\/lw\/a\d+\//.test(command)) {
    const slotMatch = command.match(/\/lw\/a(\d+)\//);
    const slot = slotMatch ? slotMatch[1] : '?';
    return {
      pid, category: 'dev-server',
      description: `Next.js server process (slot a${slot})`,
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  // Vitest runners from agent slots
  if ((command.includes('vitest') || command.includes('jest-worker/processChild')) && /\/lw\/a\d+\//.test(command)) {
    const slotMatch = command.match(/\/lw\/a(\d+)\//);
    const slot = slotMatch ? slotMatch[1] : '?';
    return {
      pid, category: 'test-runner',
      description: `Vitest runner (slot a${slot})`,
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  // build-data processes from agent slots
  if (command.includes('build-data') && /\/lw\/a\d+\//.test(command)) {
    const slotMatch = command.match(/\/lw\/a(\d+)\//);
    const slot = slotMatch ? slotMatch[1] : '?';
    return {
      pid, category: 'build-data',
      description: `Build-data process (slot a${slot})`,
      cpuPercent: cpu, memMB: Math.round(memKB / 1024),
      ageMinutes, command,
    };
  }

  return null;
}

function formatAge(minutes: number): string {
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours < 24) return `${hours}h${mins > 0 ? `${mins}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

async function resetCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const killMode = Boolean(options.kill);
  const forceMode = Boolean(options.force);

  // Get all node processes with resource info
  let psOutput: string;
  try {
    psOutput = execSync(
      'ps -eo pid,%cpu,rss,etime,command | grep -E "node|next-server" | grep -v grep',
      { encoding: 'utf-8', timeout: 5000 },
    );
  } catch {
    // grep returns exit 1 when no matches — that means no node processes
    return { exitCode: 0, output: 'No Node processes found.' };
  }

  const allProcs = parseProcesses(psOutput);
  const myPid = process.pid;

  // Classify each process
  const detected: DetectedProcess[] = [];
  for (const proc of allProcs) {
    const classified = classifyProcess(proc, myPid);
    if (classified) {
      const threshold = forceMode ? 0 : (STALE_THRESHOLDS[classified.category] ?? 60);
      if (classified.ageMinutes >= threshold) {
        detected.push(classified);
      }
    }
  }

  if (detected.length === 0) {
    return { exitCode: 0, output: 'No stale processes detected.' };
  }

  // JSON output
  if (options.json) {
    const data = { processes: detected, killMode };
    return { exitCode: 0, output: JSON.stringify(data, null, 2) };
  }

  // Group by category for display
  const byCategory = new Map<string, DetectedProcess[]>();
  for (const p of detected) {
    const list = byCategory.get(p.category) || [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  let output = '';
  const totalCpu = detected.reduce((sum, p) => sum + p.cpuPercent, 0);
  const totalMem = detected.reduce((sum, p) => sum + p.memMB, 0);

  output += `${c.bold}Stale Processes${c.reset} — ${detected.length} found (${totalCpu.toFixed(0)}% CPU, ${totalMem}MB RAM)\n\n`;

  const categoryLabels: Record<string, string> = {
    'mcp-server': 'MCP Servers',
    'dev-server': 'Dev Servers',
    'test-runner': 'Test Runners',
    'build-data': 'Build Processes',
  };

  for (const [category, procs] of byCategory) {
    const label = categoryLabels[category] ?? category;
    output += `${c.cyan}${label}${c.reset} (${procs.length})\n`;
    for (const p of procs) {
      const cpuColor = p.cpuPercent > 50 ? c.red : p.cpuPercent > 10 ? c.yellow : '';
      output += `  PID ${c.bold}${p.pid}${c.reset}  ${cpuColor}${p.cpuPercent.toFixed(0)}% CPU${c.reset}  ${p.memMB}MB  age ${formatAge(p.ageMinutes)}  ${c.dim}${p.description}${c.reset}\n`;
    }
    output += '\n';
  }

  if (!killMode) {
    output += `${c.dim}Run with --kill to terminate these processes.${c.reset}\n`;
    return { exitCode: 0, output: output.trimEnd() };
  }

  // Kill mode
  let killed = 0;
  let failed = 0;
  for (const p of detected) {
    try {
      process.kill(p.pid, 'SIGTERM');
      killed++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ESRCH')) {
        // Process already exited
        killed++;
      } else {
        output += `  ${c.red}Failed to kill PID ${p.pid}: ${msg}${c.reset}\n`;
        failed++;
      }
    }
  }

  output += `${c.green}✓${c.reset} Killed ${killed} process${killed !== 1 ? 'es' : ''}`;
  if (failed > 0) {
    output += ` (${c.red}${failed} failed${c.reset})`;
  }
  output += '\n';

  return { exitCode: failed > 0 ? 1 : 0, output: output.trimEnd() };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: resetCommand,
};

export function getHelp(): string {
  return `
Agent Reset — Find and clean stale processes left by Claude Code sessions

Detects orphaned MCP servers (playwright, puppeteer, filesystem), Next.js dev
servers from agent slots, stale vitest runners, and build processes.

Commands:
  (default)    Scan for stale processes and display them

Options:
  --kill       Kill all detected stale processes (default: dry run)
  --force      Kill regardless of age threshold
  --json       JSON output
  --ci         CI-compatible output

Age thresholds (bypassed with --force):
  MCP servers:   always stale (0 min)
  Dev servers:   >2 hours
  Test runners:  >30 minutes
  Build procs:   >1 hour

Examples:
  crux sys agent-reset                   # Show what's stale
  crux sys agent-reset --kill            # Kill stale processes
  crux sys agent-reset --kill --force    # Kill all detected (ignore age)
`;
}
