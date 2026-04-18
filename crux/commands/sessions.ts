/**
 * Sessions Command Handlers
 *
 * Create and manage agent session log YAML files.
 *
 * Usage:
 *   crux sys sessions write "Session title"               Write a session log YAML
 *   crux sys sessions write --title="Session title"       Alternative flag form
 *   crux sys sessions write "Title" --sync                Write + sync to wiki-server
 *   crux sys sessions list                                List active sessions across all slots
 *   crux sys sessions list --all                          Include completed sessions
 *   crux sys sessions list --linear=QUA-NNN               Filter by Linear ID
 *   crux sys sessions list --slot=7                       Filter by slot number
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../lib/output.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { syncSessionFile } from '../wiki-server/sync-session.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { listAgentSessions } from '../lib/wiki-server/agent-sessions.ts';
import { findClaudeProcesses } from '../lib/session/claude-processes.ts';
import {
  mergeSessions,
  filterSessions,
  sortSessions,
  toDisplayRow,
  type MergedSession,
  type Liveness,
} from '../lib/session/sessions-list.ts';
import type { CommandResult } from '../lib/cli.ts';

const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Convert a branch name into a filename-safe slug. */
function branchToSlug(branch: string): string {
  return branch
    .replace(/^claude\//, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Parse a comma- or space-separated list from CLI args. */
function parseList(val: unknown): string[] {
  if (!val) return [];
  const s = String(val);
  return s
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Build the YAML string for a session log file.
 * Uses raw string building to include comment placeholders for optional fields.
 */
function buildSessionYaml(fields: {
  date: string;
  branch: string;
  title: string;
  summary?: string;
  model?: string;
  duration?: string;
  cost?: string;
  pr?: string;
  pages: string[];
  serverUnavailable?: boolean;
}): string {
  const lines: string[] = [
    `date: "${fields.date}"`,
    `branch: ${fields.branch}`,
    `title: ${JSON.stringify(fields.title)}`,
    `summary: |`,
    `  ${fields.summary ?? '(fill in)'}`,
  ];

  if (fields.model) lines.push(`model: ${fields.model}`);
  if (fields.duration) lines.push(`duration: "${fields.duration}"`);
  if (fields.cost) lines.push(`cost: "${fields.cost}"`);
  if (fields.pr) lines.push(`pr: "${fields.pr}"`);

  if (fields.pages.length === 0) {
    lines.push('pages: []');
  } else {
    lines.push('pages:');
    for (const p of fields.pages) {
      lines.push(`  - ${p}`);
    }
  }

  // Record server unavailability as a constraint in the session log.
  // This surfaces in the page-changes dashboard so reviewers know cross-reference
  // checks and citation data may have been skipped during this session.
  if (fields.serverUnavailable) {
    lines.push(
      'constraints:',
      '  - server-unavailable: "Wiki server was unreachable during this session. Cross-reference checks, citation checking, and backlink context were unavailable."',
    );
  }

  lines.push(
    '# issues, learnings, recommendations: add as YAML lists, e.g.:',
    '# issues:',
    '#   - "Description of an issue encountered"',
    '# learnings:',
    '#   - "Something learned"',
    '# recommendations:',
    '#   - "Suggested follow-up action"',
    '# checks: (paste output of: pnpm crux sys agent-checklist snapshot)',
  );

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// write command
// ---------------------------------------------------------------------------

/**
 * Scaffold and write a session log YAML to .claude/sessions/.
 *
 * Required: --title="..." or first positional arg.
 * Optional: --summary, --model, --duration, --cost, --pr, --pages (comma-separated IDs).
 * Optional: --sync — also sync to wiki-server after writing.
 * Optional: --output=<path> — write to a custom path instead of .claude/sessions/.
 */
async function write(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean | undefined);
  const c = log.colors;

  // Resolve title: first non-flag positional arg or --title=
  const positional = args.filter((a) => !a.startsWith('--'));
  const title = positional[0] ?? (options.title as string | undefined);

  if (!title) {
    return {
      output:
        `${c.red}Error: title is required.${c.reset}\n` +
        `  Usage: pnpm crux sys sessions write "Session title" [options]\n` +
        `  Or:    pnpm crux sys sessions write --title="Session title" [options]\n`,
      exitCode: 1,
    };
  }

  const date = today();
  const branch = currentBranch();
  const slug = branchToSlug(branch);
  const filename = `${date}_${slug}.yaml`;

  const outputPath = options.output
    ? String(options.output)
    : join(SESSIONS_DIR, filename);

  // Ensure parent directory exists (handles both default and custom --output paths)
  mkdirSync(dirname(outputPath), { recursive: true });

  // Parse optional list fields
  const pages = parseList(options.pages);

  // Check wiki server availability so the scaffold can note any constraint.
  // Fire-and-forget with fallback: if the check fails, assume available.
  let serverUnavailable = false;
  try {
    serverUnavailable = !(await isServerAvailable());
  } catch {
    serverUnavailable = false;
  }

  const yamlContent = buildSessionYaml({
    date,
    branch,
    title,
    summary: options.summary ? String(options.summary) : undefined,
    model: options.model ? String(options.model) : undefined,
    duration: options.duration ? String(options.duration) : undefined,
    cost: options.cost ? String(options.cost) : undefined,
    pr: options.pr ? String(options.pr) : undefined,
    pages,
    serverUnavailable,
  });

  const alreadyExists = existsSync(outputPath);
  writeFileSync(outputPath, yamlContent, 'utf-8');

  let out = alreadyExists
    ? `${c.yellow}⚠${c.reset}  Session YAML overwritten: ${c.cyan}${outputPath}${c.reset}\n`
    : `${c.green}✓${c.reset} Session YAML written: ${c.cyan}${outputPath}${c.reset}\n`;
  out += `  Date: ${date}\n`;
  out += `  Branch: ${branch}\n`;
  out += `  Title: ${title}\n`;
  if (pages.length > 0) out += `  Pages: ${pages.join(', ')}\n`;
  if (serverUnavailable) {
    out += `  ${c.yellow}⚠ Wiki server unreachable — constraints field added to session log.${c.reset}\n`;
  }
  out += `\n  Edit the file to add summary, issues, learnings, recommendations and checks, then:\n`;
  out += `  ${c.cyan}pnpm crux sys wiki-server sync-session ${outputPath}${c.reset}\n`;

  // Optionally sync immediately
  if (options.sync) {
    log.info('Syncing to wiki-server...');
    const synced = await syncSessionFile(outputPath);
    if (synced) {
      out += `${c.green}✓ Synced to wiki-server.${c.reset}\n`;
    } else {
      out += `${c.yellow}Warning: could not sync to wiki-server (server unavailable or error).${c.reset}\n`;
    }
  }

  return { output: out, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// list command — cross-session observability (QUA-413)
// ---------------------------------------------------------------------------

const LIVENESS_BADGE: Record<Liveness, string> = {
  live: '●',
  recent: '◐',
  stale: '◯',
  ghost: '!',
  done: '✓',
};

function livenessColor(liveness: Liveness, c: ReturnType<typeof createLogger>['colors']): string {
  switch (liveness) {
    case 'live':
      return c.green;
    case 'recent':
      return c.cyan;
    case 'stale':
      return c.yellow;
    case 'ghost':
      return c.red;
    case 'done':
      return c.dim;
  }
}

function renderTable(
  rows: MergedSession[],
  colors: ReturnType<typeof createLogger>['colors'],
): string {
  if (rows.length === 0) {
    return `${colors.dim}No sessions match the filter.${colors.reset}\n`;
  }

  const display = rows.map(toDisplayRow);

  const widths = {
    badge: 2,
    slot: Math.max(4, ...display.map((d) => d.slot.length)),
    pid: Math.max(5, ...display.map((d) => d.pid.length)),
    branch: Math.max(6, ...display.map((d) => d.branch.length)),
    linear: Math.max(7, ...display.map((d) => d.linear.length)),
    pr: Math.max(4, ...display.map((d) => d.pr.length)),
    age: Math.max(3, ...display.map((d) => d.age.length)),
    task: Math.max(4, ...display.map((d) => d.task.length)),
  };

  const pad = (s: string, w: number) => s.padEnd(w);

  let out = '';
  // Header
  out += `  ${pad('', widths.badge)} ${pad('Slot', widths.slot)} ${pad('PID', widths.pid)} ${pad('Branch', widths.branch)} ${pad('Linear', widths.linear)} ${pad('PR', widths.pr)} ${pad('Age', widths.age)} ${pad('Task', widths.task)}\n`;
  out += `  ${'─'.repeat(widths.badge)} ${'─'.repeat(widths.slot)} ${'─'.repeat(widths.pid)} ${'─'.repeat(widths.branch)} ${'─'.repeat(widths.linear)} ${'─'.repeat(widths.pr)} ${'─'.repeat(widths.age)} ${'─'.repeat(widths.task)}\n`;

  for (const d of display) {
    const col = livenessColor(d.liveness, colors);
    const badge = LIVENESS_BADGE[d.liveness];
    const line = `  ${col}${pad(badge, widths.badge)}${colors.reset} ${pad(d.slot, widths.slot)} ${colors.dim}${pad(d.pid, widths.pid)}${colors.reset} ${pad(d.branch, widths.branch)} ${pad(d.linear, widths.linear)} ${pad(d.pr, widths.pr)} ${pad(d.age, widths.age)} ${pad(d.task, widths.task)}`;
    out += `${line}\n`;
  }

  // Legend
  out += `\n${colors.dim}  ${colors.green}●${colors.dim} live (<2m)   ${colors.cyan}◐${colors.dim} recent (<30m)   ${colors.yellow}◯${colors.dim} stale   ${colors.red}!${colors.dim} ghost (untracked)   ${colors.dim}✓${colors.dim} done${colors.reset}\n`;
  return out;
}

async function list(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean | undefined);
  const c = log.colors;

  const available = await isServerAvailable();
  if (!available) {
    return {
      exitCode: 1,
      output:
        `${c.red}Error: wiki-server is not reachable.${c.reset}\n` +
        `  In agent slots, set WIKI_SERVER_ENV=prod to query the production DB:\n` +
        `  ${c.cyan}WIKI_SERVER_ENV=prod pnpm crux sys sessions list${c.reset}\n`,
    };
  }

  const limit = Number(options.limit ?? 200);
  const result = await listAgentSessions(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200);
  if (!result.ok) {
    return { exitCode: 1, output: `${c.red}Error fetching sessions: ${result.message}${c.reset}\n` };
  }

  const liveMinutes = options.liveMinutes !== undefined ? Number(options.liveMinutes) : 2;
  const staleMinutes = options.fresh !== undefined ? Number(options.fresh) : 30;

  const processes = findClaudeProcesses();

  const merged = mergeSessions(result.data.sessions, processes, {
    liveMinutes: Number.isFinite(liveMinutes) && liveMinutes > 0 ? liveMinutes : 2,
    staleMinutes: Number.isFinite(staleMinutes) && staleMinutes > 0 ? staleMinutes : 30,
  });

  const filterLinear = typeof options.linear === 'string' ? options.linear : undefined;
  const filterSlot = options.slot !== undefined ? Number(options.slot) : undefined;

  const filtered = filterSessions(merged, {
    includeCompleted: Boolean(options.all),
    linearId: filterLinear,
    slot: Number.isFinite(filterSlot) ? (filterSlot as number) : undefined,
  });

  const sorted = sortSessions(filtered);

  if (options.json) {
    // Shape the JSON output with explicit fields a coordinator might script against.
    const jsonRows = sorted.map((r) => ({
      slot: r.session?.slotNumber ?? r.process?.slot ?? null,
      pid: r.process?.pid ?? null,
      cwd: r.process?.cwd ?? r.session?.worktree ?? null,
      branch: r.session?.branch ?? null,
      linearId: r.session?.linearId ?? null,
      prUrl: r.session?.prUrl ?? null,
      task: r.session?.task ?? null,
      status: r.session?.status ?? null,
      liveness: r.liveness,
      ageMinutes: r.ageMinutes,
      heartbeatAt: r.session?.heartbeatAt ?? null,
      updatedAt: r.session?.updatedAt ?? null,
      startedAt: r.session?.startedAt ?? null,
      sessionId: r.session?.id ?? null,
    }));
    return { exitCode: 0, output: JSON.stringify(jsonRows, null, 2) + '\n' };
  }

  const header = `${c.bold}Agent Sessions${c.reset} ${c.dim}(${sorted.length} row${sorted.length === 1 ? '' : 's'}${Boolean(options.all) ? '' : ', active only'})${c.reset}\n\n`;
  return { exitCode: 0, output: header + renderTable(sorted, c) };
}

// ---------------------------------------------------------------------------
// Domain entry point (required by crux.mjs dispatch)
// ---------------------------------------------------------------------------

export const commands = {
  write,
  list,
};

export function getHelp(): string {
  return `
Sessions Domain — Agent sessions: list active, write session logs

Commands:
  list [options]            List active agent sessions across all slots (QUA-413)
  write <title> [options]   Scaffold a session YAML in .claude/sessions/

List options:
  --all                     Include completed sessions (default: active only)
  --linear=QUA-NNN          Filter by Linear ID
  --slot=N                  Filter by slot number
  --fresh=N                 Staleness cutoff in minutes (default: 30)
  --live-minutes=N          "Live" threshold in minutes (default: 2)
  --limit=N                 Max DB rows to fetch (default: 200, cap 500)
  --json                    Machine-readable JSON output

Write options:
  --title=<text>            Session title (alternative to positional arg)
  --summary=<text>          Short summary of what was done
  --model=<name>            Model used (e.g. claude-sonnet-4-6)
  --duration=<text>         Approximate duration (e.g. "~30min")
  --cost=<text>             Approximate cost (e.g. "~$1.50")
  --pr=<url|number>         PR URL or number
  --pages=<id1,id2,...>     Comma-separated wiki page IDs edited
  --sync                    Also sync to wiki-server after writing
  --output=<path>           Custom output path (default: .claude/sessions/<date>_<branch>.yaml)

Examples:
  pnpm crux sys sessions list
  pnpm crux sys sessions list --all --linear=QUA-413
  pnpm crux sys sessions list --slot=9 --json
  pnpm crux sys sessions write "Fix citation parser bug"
  pnpm crux sys sessions write "Add dark mode" --model=claude-sonnet-4-6 --duration="~45min"
`.trim();
}
