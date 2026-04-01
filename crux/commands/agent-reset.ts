/**
 * Agent Reset — Reset an agent slot to a clean state between sessions
 *
 * Scans for and cleans up: stale processes, orphaned worktrees, stale
 * git branches, and WIP checklists. Pulls latest main.
 *
 * Usage:
 *   crux sys agent-reset                      Scan everything (dry run)
 *   crux sys agent-reset --kill               Clean up + pull main
 *   crux sys agent-reset --kill --force       Kill without age threshold
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
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

interface GitStatus {
  currentBranch: string;
  isDirty: boolean;
  behindMain: number;
  mergedBranches: string[];
}

interface WorktreeInfo {
  path: string;
  branch: string;
}

interface CleanupItem {
  category: 'worktree' | 'branch' | 'checklist' | 'stash';
  description: string;
  detail: string;
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

function exec(cmd: string, timeoutMs = 10000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs }).trim();
}

function execSafe(cmd: string, timeoutMs = 10000): string | null {
  try {
    return exec(cmd, timeoutMs);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git scanning
// ---------------------------------------------------------------------------

function scanGitStatus(): GitStatus {
  const currentBranch = execSafe('git rev-parse --abbrev-ref HEAD') ?? '(unknown)';

  // Check for uncommitted changes
  const statusOutput = execSafe('git status --porcelain') ?? '';
  const isDirty = statusOutput.length > 0;

  // Fetch latest main (quick, only refs)
  execSafe('git fetch origin main --quiet');

  // How far behind main?
  const behind = execSafe('git rev-list --count HEAD..origin/main');
  const behindMain = behind ? Number(behind) : 0;

  // Find local branches that have been merged into origin/main
  const mergedOutput = execSafe('git branch --merged origin/main') ?? '';
  const mergedBranches = mergedOutput
    .split('\n')
    .map(b => b.replace(/^\*?\s+/, '').trim())
    .filter(b => b && b !== 'main' && b !== 'production' && !b.startsWith('remotes/'));

  return { currentBranch, isDirty, behindMain, mergedBranches };
}

// ---------------------------------------------------------------------------
// Worktree scanning
// ---------------------------------------------------------------------------

function scanWorktrees(): WorktreeInfo[] {
  const worktreeDir = join(process.cwd(), '.claude', 'worktrees');
  if (!existsSync(worktreeDir)) return [];

  const entries = readdirSync(worktreeDir, { withFileTypes: true });
  const worktrees: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wtPath = join(worktreeDir, entry.name);
    const branch = execSafe(`git -C "${wtPath}" rev-parse --abbrev-ref HEAD`) ?? '(detached)';
    worktrees.push({ path: wtPath, branch });
  }

  return worktrees;
}

// ---------------------------------------------------------------------------
// Cleanup item scanning
// ---------------------------------------------------------------------------

function scanCleanupItems(): CleanupItem[] {
  const items: CleanupItem[] = [];

  // Stale WIP checklist
  const checklistPath = join(process.cwd(), '.claude', 'wip-checklist.md');
  if (existsSync(checklistPath)) {
    items.push({
      category: 'checklist',
      description: 'Stale WIP checklist from previous session',
      detail: checklistPath,
    });
  }

  // Git stashes
  const stashList = execSafe('git stash list') ?? '';
  const stashCount = stashList ? stashList.split('\n').filter(Boolean).length : 0;
  if (stashCount > 0) {
    items.push({
      category: 'stash',
      description: `${stashCount} git stash${stashCount > 1 ? 'es' : ''}`,
      detail: stashList.split('\n').slice(0, 3).join('; ') + (stashCount > 3 ? ` ... +${stashCount - 3} more` : ''),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Stale process scanning (existing logic)
// ---------------------------------------------------------------------------

function scanStaleProcesses(forceMode: boolean): DetectedProcess[] {
  let psOutput: string;
  try {
    psOutput = execSync(
      'ps -eo pid,%cpu,rss,etime,command | grep -E "node|next-server" | grep -v grep',
      { encoding: 'utf-8', timeout: 5000 },
    );
  } catch {
    return [];
  }

  const allProcs = parseProcesses(psOutput);
  const myPid = process.pid;
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

  return detected;
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

  let output = '';
  let totalIssues = 0;

  // ── 1. Git status ──────────────────────────────────────────────────────
  const git = scanGitStatus();

  output += `${c.bold}Git${c.reset}\n`;
  output += `  Branch: ${c.cyan}${git.currentBranch}${c.reset}`;
  if (git.isDirty) output += ` ${c.yellow}(dirty)${c.reset}`;
  output += '\n';

  if (git.behindMain > 0) {
    output += `  ${c.yellow}${git.behindMain} commits behind origin/main${c.reset}\n`;
    totalIssues++;
  } else {
    output += `  ${c.green}Up to date with origin/main${c.reset}\n`;
  }

  if (git.mergedBranches.length > 0) {
    output += `  ${c.yellow}${git.mergedBranches.length} merged branch${git.mergedBranches.length > 1 ? 'es' : ''}: ${git.mergedBranches.join(', ')}${c.reset}\n`;
    totalIssues++;
  }
  output += '\n';

  // ── 2. Worktrees ──────────────────────────────────────────────────────
  const worktrees = scanWorktrees();
  if (worktrees.length > 0) {
    output += `${c.bold}Worktrees${c.reset} — ${worktrees.length} orphaned\n`;
    for (const wt of worktrees) {
      const name = wt.path.split('/').pop();
      output += `  ${c.yellow}${name}${c.reset} (${wt.branch})\n`;
    }
    output += '\n';
    totalIssues++;
  }

  // ── 3. Cleanup items ──────────────────────────────────────────────────
  const cleanupItems = scanCleanupItems();
  if (cleanupItems.length > 0) {
    output += `${c.bold}Cleanup${c.reset}\n`;
    for (const item of cleanupItems) {
      output += `  ${c.yellow}${item.description}${c.reset}\n`;
    }
    output += '\n';
    totalIssues++;
  }

  // ── 4. Stale processes ────────────────────────────────────────────────
  const detected = scanStaleProcesses(forceMode);
  if (detected.length > 0) {
    const totalCpu = detected.reduce((sum, p) => sum + p.cpuPercent, 0);
    const totalMem = detected.reduce((sum, p) => sum + p.memMB, 0);

    output += `${c.bold}Stale Processes${c.reset} — ${detected.length} found (${totalCpu.toFixed(0)}% CPU, ${totalMem}MB RAM)\n`;

    const categoryLabels: Record<string, string> = {
      'mcp-server': 'MCP Servers',
      'dev-server': 'Dev Servers',
      'test-runner': 'Test Runners',
      'build-data': 'Build Processes',
    };

    const byCategory = new Map<string, DetectedProcess[]>();
    for (const p of detected) {
      const list = byCategory.get(p.category) || [];
      list.push(p);
      byCategory.set(p.category, list);
    }

    for (const [category, procs] of byCategory) {
      const label = categoryLabels[category] ?? category;
      output += `  ${c.cyan}${label}${c.reset} (${procs.length})\n`;
      for (const p of procs) {
        const cpuColor = p.cpuPercent > 50 ? c.red : p.cpuPercent > 10 ? c.yellow : '';
        output += `    PID ${c.bold}${p.pid}${c.reset}  ${cpuColor}${p.cpuPercent.toFixed(0)}% CPU${c.reset}  ${p.memMB}MB  age ${formatAge(p.ageMinutes)}  ${c.dim}${p.description}${c.reset}\n`;
      }
    }
    output += '\n';
    totalIssues++;
  }

  // ── JSON output ────────────────────────────────────────────────────────
  if (options.json) {
    const data = {
      git,
      worktrees: worktrees.map(w => ({ path: w.path, branch: w.branch })),
      cleanupItems: cleanupItems.map(i => ({ category: i.category, description: i.description })),
      processes: detected,
      killMode,
    };
    return { exitCode: 0, output: JSON.stringify(data, null, 2) };
  }

  // ── Dry run summary ────────────────────────────────────────────────────
  if (!killMode) {
    if (totalIssues === 0) {
      output += `${c.green}✓${c.reset} Slot is clean — nothing to reset.\n`;
    } else {
      output += `${c.dim}Run with --kill to clean up.${c.reset}\n`;
    }
    return { exitCode: 0, output: output.trimEnd() };
  }

  // ── Kill mode: execute cleanup ─────────────────────────────────────────
  output += `${c.bold}Actions${c.reset}\n`;

  // 4a. Kill stale processes
  if (detected.length > 0) {
    let killed = 0;
    let failed = 0;
    for (const p of detected) {
      try {
        process.kill(p.pid, 'SIGTERM');
        killed++;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ESRCH')) {
          killed++;
        } else {
          output += `  ${c.red}Failed to kill PID ${p.pid}: ${msg}${c.reset}\n`;
          failed++;
        }
      }
    }
    output += `  ${c.green}✓${c.reset} Killed ${killed} stale process${killed !== 1 ? 'es' : ''}`;
    if (failed > 0) output += ` (${c.red}${failed} failed${c.reset})`;
    output += '\n';
  }

  // 4b. Remove orphaned worktrees
  for (const wt of worktrees) {
    try {
      exec(`git worktree remove "${wt.path}" --force`);
      const name = wt.path.split('/').pop();
      output += `  ${c.green}✓${c.reset} Removed worktree ${name}\n`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      output += `  ${c.red}✗ Failed to remove worktree ${wt.path}: ${msg}${c.reset}\n`;
    }
  }

  // 4c. Remove stale WIP checklist
  for (const item of cleanupItems) {
    if (item.category === 'checklist') {
      try {
        unlinkSync(item.detail);
        output += `  ${c.green}✓${c.reset} Removed stale WIP checklist\n`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        output += `  ${c.red}✗ Failed to remove checklist: ${msg}${c.reset}\n`;
      }
    }
    if (item.category === 'stash') {
      try {
        exec('git stash clear');
        output += `  ${c.green}✓${c.reset} Cleared git stashes\n`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        output += `  ${c.red}✗ Failed to clear stashes: ${msg}${c.reset}\n`;
      }
    }
  }

  // 4d. Delete merged branches
  for (const branch of git.mergedBranches) {
    try {
      exec(`git branch -d "${branch}"`);
      output += `  ${c.green}✓${c.reset} Deleted merged branch ${branch}\n`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      output += `  ${c.red}✗ Failed to delete branch ${branch}: ${msg}${c.reset}\n`;
    }
  }

  // 4e. Pull latest main
  if (git.behindMain > 0 || git.currentBranch !== 'main') {
    if (git.isDirty) {
      output += `  ${c.yellow}⚠ Working tree is dirty — skipping checkout/pull. Commit or stash changes first.${c.reset}\n`;
    } else {
      try {
        if (git.currentBranch !== 'main') {
          exec('git checkout main');
          output += `  ${c.green}✓${c.reset} Checked out main\n`;
        }
        exec('git pull origin main --ff-only', 30000);
        output += `  ${c.green}✓${c.reset} Pulled latest main\n`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        output += `  ${c.red}✗ Failed to pull main: ${msg}${c.reset}\n`;
      }
    }
  }

  return { exitCode: 0, output: output.trimEnd() };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: resetCommand,
};

export function getHelp(): string {
  return `
Agent Reset — Reset an agent slot to a clean state between sessions

Scans for stale processes, orphaned worktrees, merged branches, stale WIP
checklists, and git stashes. Pulls latest main when cleaning up.

Commands:
  (default)    Scan everything and show what needs cleanup (dry run)

Options:
  --kill       Execute cleanup: kill processes, remove worktrees,
               delete merged branches, clear stashes, pull main
  --force      Kill processes regardless of age threshold
  --json       JSON output
  --ci         CI-compatible output

Cleanup actions (with --kill):
  1. Kill stale processes (MCP servers, dev servers, test runners)
  2. Remove orphaned .claude/worktrees/
  3. Delete stale .claude/wip-checklist.md
  4. Clear git stashes
  5. Delete local branches merged into main
  6. Checkout main and pull latest

Examples:
  crux sys agent-reset                   # Scan — show what's stale
  crux sys agent-reset --kill            # Full cleanup + pull main
  crux sys agent-reset --kill --force    # Kill all processes (ignore age)
`;
}
