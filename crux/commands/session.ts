/**
 * Session Command Handlers
 *
 * Manage session checklists: generate, track progress, and validate completion.
 *
 * Usage:
 *   crux session init <task> --type=X   Generate a typed checklist
 *   crux session init --issue=N         Auto-detect type from issue labels
 *   crux session status                 Show checklist progress
 *   crux session complete               Validate all items checked
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import {
  buildChecklist,
  parseChecklist,
  formatStatus,
  detectTypeFromLabels,
  currentBranch,
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
 *   crux session init "Task description" --type=bugfix
 *   crux session init --issue=42
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
      output: `${c.red}Usage: crux session init "Task description" --type=X\n       crux session init --issue=N${c.reset}\n`,
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
  output += `${c.green}✓${c.reset} Session checklist created: ${c.cyan}.claude/wip-checklist.md${c.reset}\n`;
  output += `  Type: ${c.bold}${type}${c.reset}\n`;
  output += `  Task: ${task}\n`;
  output += `  Branch: ${c.cyan}${metadata.branch}${c.reset}\n`;
  if (issue) {
    output += `  Issue: ${c.cyan}#${issue}${c.reset}\n`;
  }

  // Count items
  const status = parseChecklist(markdown);
  output += `  Items: ${status.totalItems}\n`;
  output += `\n${c.dim}Work through the checklist as you go. Run \`crux session status\` to check progress.${c.reset}\n`;

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
      output: `${c.yellow}No checklist found. Run \`crux session init\` first.${c.reset}\n`,
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
      output: `${c.red}No checklist found. Run \`crux session init\` first.${c.reset}\n`,
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
    output += `\n${c.dim}Session is ready to ship.${c.reset}\n`;
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

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: init,
  init,
  status,
  complete,
};

export function getHelp(): string {
  return `
Session Domain - Manage session checklists

Commands:
  init <task>      Generate a typed checklist (default)
  status           Show checklist progress
  complete         Validate all items checked (exit code 1 if incomplete)

Options:
  --type=TYPE      Session type: content, infrastructure, bugfix, refactor, commands
  --issue=N        Auto-detect type from GitHub issue labels
  --ci             JSON output

Type detection from issue labels:
  bug, defect            → bugfix
  refactor, cleanup      → refactor
  content, wiki, page    → content
  claude-commands        → commands
  (other/none)           → infrastructure

Examples:
  crux session init "Add session checklist CLI" --type=commands
  crux session init --issue=42
  crux session init "Fix broken scoring" --type=bugfix
  crux session status
  crux session complete

Checklist markers:
  [x]  Checked (complete)
  [ ]  Unchecked (incomplete)
  [~]  N/A (not applicable — counts as passing)

Slash commands:
  /kickoff    Runs \`crux session init\` and presents the checklist
  /finalize   Runs \`crux session status\`, completes items, ships
`;
}
