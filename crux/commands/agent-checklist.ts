/**
 * Agent Checklist Command Handlers
 *
 * Manage agent checklists: generate, track progress, and validate completion.
 *
 * Usage:
 *   crux agent-checklist init <task> --type=X   Generate a typed checklist
 *   crux agent-checklist init --issue=N         Auto-detect type from issue labels
 *   crux agent-checklist check <id> [id2...]    Check off items by ID
 *   crux agent-checklist verify                 Auto-verify items with verifyCommand
 *   crux agent-checklist status                 Show checklist progress
 *   crux agent-checklist complete               Validate all items checked
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import {
  buildChecklist,
  parseChecklist,
  formatStatus,
  detectTypeFromLabels,
  checkItems,
  currentBranch,
  CHECKLIST_ITEMS,
  type SessionType,
  type ChecklistMetadata,
} from '../lib/session-checklist.ts';
import type { CommandResult } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKLIST_PATH = join(PROJECT_ROOT, '.claude/wip-checklist.md');
const VALID_TYPES: SessionType[] = ['content', 'infrastructure', 'bugfix', 'refactor', 'commands'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandOptions {
  ci?: boolean;
  type?: string;
  issue?: string;
  [key: string]: unknown;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Initialize a session checklist.
 *
 * Usage:
 *   crux agent-checklist init "Task description" --type=bugfix
 *   crux agent-checklist init --issue=42
 */
async function init(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // Determine session type
  let type: SessionType = 'infrastructure';
  let task = args.filter(a => !a.startsWith('--')).join(' ') || '';
  let issue: number | undefined;

  if (options.issue) {
    const issueNum = parseInt(options.issue as string, 10);
    if (!issueNum || isNaN(issueNum)) {
      return {
        output: `${c.red}Invalid issue number: ${options.issue}${c.reset}\n`,
        exitCode: 1,
      };
    }
    issue = issueNum;

    // Fetch issue details and auto-detect type
    try {
      const issueData = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
      const labels = issueData.labels.map(l => l.name);
      type = detectTypeFromLabels(labels);
      if (!task) {
        task = issueData.title;
      }
    } catch (err) {
      return {
        output: `${c.red}Failed to fetch issue #${issueNum}: ${(err as Error).message}${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  // Override type if explicitly provided
  if (options.type) {
    const t = options.type as string;
    if (!VALID_TYPES.includes(t as SessionType)) {
      return {
        output: `${c.red}Invalid type: ${t}. Valid types: ${VALID_TYPES.join(', ')}${c.reset}\n`,
        exitCode: 1,
      };
    }
    type = t as SessionType;
  }

  if (!task) {
    return {
      output: `${c.red}Usage: crux agent-checklist init "Task description" --type=X\n       crux agent-checklist init --issue=N${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Build metadata
  const metadata: ChecklistMetadata = {
    task,
    branch: currentBranch(),
    timestamp: new Date().toISOString(),
    issue,
  };

  // Generate checklist
  const markdown = buildChecklist(type, metadata);

  // Write to file
  writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');

  let output = '';
  output += `${c.green}✓${c.reset} Agent checklist created: ${c.cyan}.claude/wip-checklist.md${c.reset}\n`;
  output += `  Type: ${c.bold}${type}${c.reset}\n`;
  output += `  Task: ${task}\n`;
  output += `  Branch: ${c.cyan}${metadata.branch}${c.reset}\n`;
  if (issue) {
    output += `  Issue: ${c.cyan}#${issue}${c.reset}\n`;
  }

  // Count items
  const status = parseChecklist(markdown);
  output += `  Items: ${status.totalItems}\n`;
  output += `\n${c.dim}Work through the checklist as you go. Run \`crux agent-checklist status\` to check progress.${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Show checklist progress.
 */
async function status(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return {
      output: `${c.yellow}No checklist found. Run \`crux agent-checklist init\` first.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const checklistStatus = parseChecklist(markdown);

  if (options.ci) {
    return {
      output: JSON.stringify({
        totalChecked: checklistStatus.totalChecked,
        totalItems: checklistStatus.totalItems,
        allPassing: checklistStatus.allPassing,
        decisions: checklistStatus.decisions,
        phases: checklistStatus.phases.map(p => ({
          phase: p.phase,
          checked: p.checked,
          total: p.total,
        })),
      }, null, 2),
      exitCode: 0,
    };
  }

  const output = formatStatus(checklistStatus, {
    green: c.green,
    yellow: c.yellow,
    red: c.red,
    cyan: c.cyan,
    bold: c.bold,
    dim: c.dim,
    reset: c.reset,
  });

  return { output, exitCode: 0 };
}

/**
 * Validate that all checklist items are complete.
 * Returns exit code 1 if any unchecked items remain.
 */
async function complete(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return {
      output: `${c.red}No checklist found. Run \`crux agent-checklist init\` first.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const checklistStatus = parseChecklist(markdown);

  if (checklistStatus.allPassing) {
    let output = `${c.green}✓ All ${checklistStatus.totalItems} checklist items complete!${c.reset}\n`;
    if (checklistStatus.decisions.length > 0) {
      output += `\n${c.bold}Key Decisions (${checklistStatus.decisions.length}):${c.reset}\n`;
      for (const d of checklistStatus.decisions) {
        output += `  ${c.cyan}-${c.reset} ${d}\n`;
      }
    }
    output += `\n${c.dim}Ready to ship.${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  // Find unchecked items
  const unchecked: Array<{ phase: string; label: string }> = [];
  for (const phase of checklistStatus.phases) {
    for (const item of phase.items) {
      if (item.status === 'unchecked') {
        unchecked.push({ phase: phase.phase, label: item.label });
      }
    }
  }

  let output = '';
  output += `${c.red}✗ ${unchecked.length} unchecked item${unchecked.length === 1 ? '' : 's'} remaining:${c.reset}\n\n`;
  for (const item of unchecked) {
    output += `  ${c.red}[ ]${c.reset} ${c.dim}(${item.phase})${c.reset} ${item.label}\n`;
  }
  output += `\n${c.dim}Complete all items or mark as N/A [~] before shipping.${c.reset}\n`;

  return { output, exitCode: 1 };
}

/**
 * Check off one or more items by ID.
 *
 * Usage:
 *   crux agent-checklist check read-issue explore-code plan-approach
 *   crux agent-checklist check --na fix-escaping   (mark as N/A)
 */
async function check(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return {
      output: `${c.red}No checklist found. Run \`crux agent-checklist init\` first.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const ids = args.filter(a => !a.startsWith('--'));
  // If --na consumed the next arg as its value (CLI parser quirk), rescue it as an ID
  if (typeof options.na === 'string') {
    ids.push(options.na as string);
  }
  if (ids.length === 0) {
    return {
      output: `${c.red}Usage: crux agent-checklist check <id> [id2 ...]\n${c.dim}Run \`crux agent-checklist status\` to see item IDs.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const marker = options.na ? '~' as const : 'x' as const;
  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const result = checkItems(markdown, ids, marker);

  if (result.checked.length > 0) {
    writeFileSync(CHECKLIST_PATH, result.markdown, 'utf-8');
  }

  let output = '';
  for (const id of result.checked) {
    const symbol = marker === 'x' ? `${c.green}[x]${c.reset}` : `${c.dim}[~]${c.reset}`;
    output += `  ${symbol} ${id}\n`;
  }
  for (const id of result.notFound) {
    output += `  ${c.red}???${c.reset} ${id} (not found in checklist)\n`;
  }

  // Show progress summary
  const updated = parseChecklist(result.checked.length > 0 ? result.markdown : markdown);
  output += `\n${c.dim}${updated.totalChecked}/${updated.totalItems} items complete${c.reset}\n`;

  return {
    output,
    exitCode: result.notFound.length > 0 ? 1 : 0,
  };
}

/**
 * Auto-verify items that have a verifyCommand.
 * Runs each command and checks off items that pass (exit 0).
 */
async function verify(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return {
      output: `${c.red}No checklist found. Run \`crux agent-checklist init\` first.${c.reset}\n`,
      exitCode: 1,
    };
  }

  let markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const currentStatus = parseChecklist(markdown);

  // Find unchecked items that have verifyCommand
  const uncheckedIds = new Set<string>();
  for (const phase of currentStatus.phases) {
    for (const item of phase.items) {
      if (item.status === 'unchecked') {
        uncheckedIds.add(item.id);
      }
    }
  }

  const verifiable = CHECKLIST_ITEMS.filter(
    item => item.verifyCommand && uncheckedIds.has(item.id)
  );

  if (verifiable.length === 0) {
    return {
      output: `${c.dim}No unchecked items with auto-verify commands.${c.reset}\n`,
      exitCode: 0,
    };
  }

  let output = `${c.bold}Running auto-verify on ${verifiable.length} items...${c.reset}\n\n`;
  const passed: string[] = [];
  const failed: Array<{ id: string; label: string }> = [];

  for (const item of verifiable) {
    output += `  ${c.dim}▸${c.reset} ${item.label}... `;
    try {
      execSync(item.verifyCommand!, {
        cwd: PROJECT_ROOT,
        stdio: 'pipe',
        timeout: 300_000, // 5 min — gate check can be slow
      });
      output += `${c.green}✓${c.reset}\n`;
      passed.push(item.id);
    } catch {
      output += `${c.red}✗${c.reset}\n`;
      failed.push({ id: item.id, label: item.label });
    }
  }

  // Check off all passed items
  if (passed.length > 0) {
    const result = checkItems(markdown, passed, 'x');
    markdown = result.markdown;
    writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');
  }

  output += `\n${c.green}${passed.length} passed${c.reset}`;
  if (failed.length > 0) {
    output += `, ${c.red}${failed.length} failed${c.reset}`;
  }
  output += '\n';

  // Show updated progress
  const updatedStatus = parseChecklist(markdown);
  output += `${c.dim}${updatedStatus.totalChecked}/${updatedStatus.totalItems} items complete${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: init,
  init,
  check,
  verify,
  status,
  complete,
};

export function getHelp(): string {
  return `
Agent Checklist Domain - Manage agent checklists

Commands:
  init <task>      Generate a typed checklist (default)
  check <id>...    Check off items by ID (accepts multiple IDs)
  verify           Auto-run verifiable items and check off those that pass
  status           Show checklist progress
  complete         Validate all items checked (exit code 1 if incomplete)

Options:
  --type=TYPE      Task type: content, infrastructure, bugfix, refactor, commands
  --issue=N        Auto-detect type from GitHub issue labels
  --na             Mark items as N/A [~] instead of checked [x] (for \`check\`)
  --ci             JSON output

Type detection from issue labels:
  bug, defect            → bugfix
  refactor, cleanup      → refactor
  content, wiki, page    → content
  claude-commands        → commands
  (other/none)           → infrastructure

Examples:
  crux agent-checklist init "Add checklist CLI" --type=commands
  crux agent-checklist init --issue=42
  crux agent-checklist check read-issue explore-code plan-approach
  crux agent-checklist check --na fix-escaping
  crux agent-checklist verify
  crux agent-checklist status
  crux agent-checklist complete

Checklist markers:
  [x]  Checked (complete)
  [ ]  Unchecked (incomplete)
  [~]  N/A (not applicable — counts as passing)

Slash commands:
  /agent-session-start      Runs \`crux agent-checklist init\` and presents the checklist
  /agent-session-ready-PR   Runs \`crux agent-checklist status\`, completes items, ships
`;
}
