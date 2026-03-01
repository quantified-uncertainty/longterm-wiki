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
  buildChecklistSnapshot,
  formatSnapshotAsYaml,
  type SessionType,
  type ChecklistMetadata,
} from '../lib/session-checklist.ts';
import type { CommandResult } from '../lib/cli.ts';
import {
  upsertAgentSession,
  updateAgentSession,
  getAgentSessionByBranch,
} from '../lib/wiki-server/agent-sessions.ts';
import { registerAgent, listActiveAgents, updateAgent } from '../lib/wiki-server/active-agents.ts';
import { appendEvent } from '../lib/wiki-server/agent-session-events.ts';

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
  reason?: string;
  [key: string]: unknown;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  html_url: string;
}

// ---------------------------------------------------------------------------
// DB Sync Helper
// ---------------------------------------------------------------------------

/**
 * Best-effort sync of the current checklist to the wiki-server DB.
 * Looks up the session by current branch and updates the checklist_md.
 */
async function syncChecklistToDb(markdown: string): Promise<void> {
  try {
    const branch = currentBranch();
    const sessionResult = await getAgentSessionByBranch(branch);
    if (sessionResult.ok) {
      await updateAgentSession(sessionResult.data.id, { checklistMd: markdown });
    }
  } catch {
    // Best-effort — local file is always the primary cache
  }
}

/**
 * Best-effort event logging. Resolves agent ID from current branch and
 * appends an event to the activity timeline.
 */
async function logEvent(
  eventType: 'registered' | 'checklist_check' | 'status_update' | 'error' | 'note' | 'completed',
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const branch = currentBranch();
    const agentsResult = await listActiveAgents('active');
    if (!agentsResult.ok) return;

    const agent = agentsResult.data.agents.find(a => a.sessionId === branch);
    if (!agent) return;

    await appendEvent({
      agentId: agent.id,
      eventType,
      message,
      metadata: metadata ?? null,
    });
  } catch {
    // Best-effort — don't block CLI operations on event logging
  }
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
  let markdown = buildChecklist(type, metadata);

  // If no issue number, auto-mark issue-tracking as N/A so it's explicit rather than silently unchecked
  if (!issue) {
    const naResult = checkItems(markdown, ['issue-tracking'], '~', 'no GitHub issue for this session');
    markdown = naResult.markdown;
  }

  // Write to local file (cache/fallback)
  writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');

  // Sync to DB (best-effort — local file is the fallback)
  let dbSynced = false;
  try {
    const result = await upsertAgentSession({
      branch: metadata.branch,
      task,
      sessionType: type,
      issueNumber: issue ?? null,
      checklistMd: markdown,
    });
    dbSynced = result.ok;
  } catch {
    // DB sync is best-effort; local file is always written
  }

  // Register with active-agents coordination system (best-effort)
  let agentRegistered = false;
  let sessionName: string | null = null;
  try {
    const agentResult = await registerAgent({
      sessionId: metadata.branch,
      branch: metadata.branch,
      task,
      issueNumber: issue ?? null,
    });
    agentRegistered = agentResult.ok;
    if (agentResult.ok && agentResult.data.sessionName) {
      sessionName = agentResult.data.sessionName;
    }
  } catch {
    // Best-effort — coordination is helpful but not blocking
  }

  // Log a 'registered' event to the activity timeline (best-effort)
  if (agentRegistered) {
    const issueRef = issue ? ` (issue #${issue})` : '';
    await logEvent('registered', `Session started: ${task}${issueRef}`, {
      sessionType: type,
      issueNumber: issue ?? null,
    });
  }

  let output = '';
  output += `${c.green}✓${c.reset} Agent checklist created: ${c.cyan}.claude/wip-checklist.md${c.reset}\n`;
  output += `  Type: ${c.bold}${type}${c.reset}\n`;
  output += `  Task: ${task}\n`;
  output += `  Branch: ${c.cyan}${metadata.branch}${c.reset}\n`;
  if (issue) {
    output += `  Issue: ${c.cyan}#${issue}${c.reset}\n`;
  } else {
    output += `  ${c.dim}issue-tracking auto-marked N/A (no GitHub issue)${c.reset}\n`;
  }

  // Count items
  const status = parseChecklist(markdown);
  output += `  Items: ${status.totalItems}\n`;
  if (dbSynced) {
    output += `  ${c.dim}Synced to wiki-server DB${c.reset}\n`;
  }
  if (agentRegistered) {
    output += `  ${c.dim}Registered with active-agents tracker${c.reset}\n`;
  }
  if (sessionName) {
    output += `  Session: ${c.bold}${sessionName}${c.reset}\n`;
  }
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

    // Mark E912 agent session as completed (best-effort)
    try {
      const branch = currentBranch();
      const sessionResult = await getAgentSessionByBranch(branch);
      if (sessionResult.ok && sessionResult.data.status === 'active') {
        await updateAgentSession(sessionResult.data.id, { status: 'completed' });
        output += `${c.dim}Agent session marked completed (E912)${c.reset}\n`;
      }
    } catch {
      // Best-effort — don't block completion on API failure
    }

    // Mark E925 active agent as completed (best-effort)
    try {
      const branch = currentBranch();
      const agentsResult = await listActiveAgents('active');
      if (agentsResult.ok) {
        const myAgent = agentsResult.data.agents.find(a => a.sessionId === branch);
        if (myAgent) {
          await updateAgent(myAgent.id, { status: 'completed' });
          output += `${c.dim}Active agent marked completed (E925)${c.reset}\n`;
        }
      }
    } catch {
      // Best-effort — don't block completion on API failure
    }

    // Log 'completed' event to the activity timeline (best-effort)
    await logEvent('completed', `Session completed: all ${checklistStatus.totalItems} checklist items passed`, {
      totalItems: checklistStatus.totalItems,
      decisions: checklistStatus.decisions,
    });

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
 *   crux agent-checklist check --na fix-escaping --reason "pure TypeScript change"   (mark as N/A)
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
  const reason = typeof options.reason === 'string' ? options.reason.trim() : undefined;

  if (options.na && !reason) {
    return {
      output: `${c.red}--reason is required when marking N/A.\n  Example: crux agent-checklist check --na issue-tracking --reason "no GitHub issue for this session"${c.reset}\n`,
      exitCode: 1,
    };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const result = checkItems(markdown, ids, marker, reason);

  if (result.checked.length > 0) {
    writeFileSync(CHECKLIST_PATH, result.markdown, 'utf-8');

    // Sync updated checklist to DB (best-effort; inner try-catch handles errors)
    await syncChecklistToDb(result.markdown);

    // Log checklist_check event (best-effort)
    const label = marker === 'x' ? 'Checked' : 'Marked N/A';
    await logEvent('checklist_check', `${label}: ${result.checked.join(', ')}`, {
      items: result.checked,
      marker,
      reason: reason ?? null,
    });
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

    // Sync to DB (best-effort; inner try-catch handles errors)
    await syncChecklistToDb(markdown);
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

/**
 * Output the current checklist state as YAML for inclusion in a session log.
 *
 * Usage:
 *   crux agent-checklist snapshot
 *
 * Outputs a `checks:` YAML block that can be pasted directly into the session
 * log file. When no checklist exists, outputs `checks: {initialized: false}`.
 *
 * The `initiated_at` timestamp in the output reveals whether the checklist was
 * initialized at session start (good) or created at the last minute (red flag).
 */
async function snapshot(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    const yaml = 'checks:\n  initialized: false';
    if (options.ci) {
      return {
        output: JSON.stringify({ initialized: false }),
        exitCode: 0,
      };
    }
    let output = yaml + '\n';
    output += `\n${c.yellow}⚠${c.reset}  No checklist found. Run \`crux agent-checklist init\` at session start.\n`;
    output += `${c.dim}Including this in session logs shows the checklist was skipped.${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const snapshotData = buildChecklistSnapshot(markdown);

  if (options.ci) {
    return {
      output: JSON.stringify(snapshotData, null, 2),
      exitCode: 0,
    };
  }

  const yaml = formatSnapshotAsYaml(snapshotData);
  let output = yaml + '\n';

  // Annotate with guidance
  const pct = snapshotData.total ? Math.round(((snapshotData.completed ?? 0) / snapshotData.total) * 100) : 0;
  const statusColor = pct === 100 ? c.green : pct >= 50 ? c.yellow : c.red;
  output += `\n${statusColor}${snapshotData.completed}/${snapshotData.total} items completed (${pct}%)${c.reset}`;
  if ((snapshotData.skipped ?? 0) > 0) {
    output += ` ${c.red}— ${snapshotData.skipped} item(s) skipped${c.reset}`;
  }
  output += '\n';
  output += `${c.dim}Paste the checks: block above into your session log file.${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Pre-push hook integration
// ---------------------------------------------------------------------------

/**
 * Called by the pre-push git hook. Two things:
 *
 *   1. Auto-verify: runs verifyCommand for any unchecked items that can be
 *      validated automatically (pr-description, escaping, entity-links, etc.).
 *      gate-passes is pre-checked before verify runs because the gate already
 *      passed for the hook to reach this point.
 *
 *   2. Completion check:
 *      - < 10% complete: exit 1 (blocks push — session skipped the workflow)
 *      - < 25% complete: exit 0 with loud warning
 *      - >= 25% complete: exit 0 silently
 */
async function prePushCheck(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // No checklist? Nothing to do.
  if (!existsSync(CHECKLIST_PATH)) {
    return { output: '', exitCode: 0 };
  }

  let output = `${c.bold}Agent checklist checks...${c.reset}\n`;

  // Step 1: Mark gate-passes as checked — we know it passed to reach this point.
  let markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const preStatus = parseChecklist(markdown);
  const gateItem = preStatus.phases.flatMap(p => p.items).find(i => i.id === 'gate-passes');
  if (gateItem?.status === 'unchecked') {
    const result = checkItems(markdown, ['gate-passes'], 'x');
    markdown = result.markdown;
    writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');
    await syncChecklistToDb(markdown);
    output += `  ${c.green}✓${c.reset} gate-passes (auto-checked — gate passed)\n`;
  }

  // Step 2: Run remaining auto-verify items (gate-passes is now checked, so skipped).
  const verifyResult = await verify([], options);
  output += verifyResult.output;

  // Step 3: Check completion level and warn or block accordingly.
  markdown = readFileSync(CHECKLIST_PATH, 'utf-8'); // re-read after verify updates
  const finalStatus = parseChecklist(markdown);
  const pct =
    finalStatus.totalItems > 0
      ? Math.round((finalStatus.totalChecked / finalStatus.totalItems) * 100)
      : 0;

  // Count unchecked blocking items separately from advisory
  const allItems = finalStatus.phases.flatMap(p => p.items);
  const uncheckedBlocking: string[] = [];
  const uncheckedAdvisory: string[] = [];
  for (const item of allItems) {
    if (item.status === 'unchecked') {
      const catalogItem = CHECKLIST_ITEMS.find(ci => ci.id === item.id);
      if (catalogItem?.priority === 'advisory') {
        uncheckedAdvisory.push(item.id);
      } else {
        uncheckedBlocking.push(item.id);
      }
    }
  }

  if (pct < 10) {
    // Hard block: checklist was initialized but barely touched — the session
    // skipped the end-of-session workflow entirely. Exit 1 to block the push.
    output += `\n${c.red}✗ Agent checklist is only ${finalStatus.totalChecked}/${finalStatus.totalItems} items complete (${pct}%).${c.reset}\n`;
    output += `${c.red}  Run /agent-session-ready-PR before pushing.${c.reset}\n`;
    output += `${c.dim}  To bypass: git push --no-verify${c.reset}\n\n`;
    return { output, exitCode: 1 };
  }

  if (uncheckedBlocking.length > 0 && pct < 75) {
    output += `\n${c.yellow}⚠️  WARNING: ${uncheckedBlocking.length} blocking item(s) unchecked:${c.reset}\n`;
    for (const id of uncheckedBlocking.slice(0, 5)) {
      output += `  ${c.red}[ ]${c.reset} ${id}\n`;
    }
    if (uncheckedBlocking.length > 5) {
      output += `  ${c.dim}...and ${uncheckedBlocking.length - 5} more${c.reset}\n`;
    }
    output += `${c.yellow}   Did you run /agent-session-ready-PR before pushing?${c.reset}\n`;
    output += `${c.dim}   To bypass: git push --no-verify${c.reset}\n\n`;
  } else if (pct < 25) {
    output += `\n${c.yellow}⚠️  WARNING: Agent checklist is only ${finalStatus.totalChecked}/${finalStatus.totalItems} items complete (${pct}%).${c.reset}\n`;
    output += `${c.yellow}   Did you run /agent-session-ready-PR before pushing?${c.reset}\n`;
    output += `${c.dim}   To bypass: git push --no-verify${c.reset}\n\n`;
  }

  if (uncheckedAdvisory.length > 0) {
    output += `${c.dim}  ${uncheckedAdvisory.length} advisory item(s) skipped (non-blocking)${c.reset}\n`;
  }

  // Step 4: Warn if tooling-gaps-found is checked but Key Decisions is empty.
  const toolingGapsItem = finalStatus.phases
    .flatMap(p => p.items)
    .find(i => i.id === 'tooling-gaps-found');
  if (
    toolingGapsItem &&
    toolingGapsItem.status !== 'unchecked' &&
    finalStatus.decisions.length === 0
  ) {
    output += `\n${c.yellow}⚠️  WARNING: \`tooling-gaps-found\` is checked but Key Decisions section is empty.${c.reset}\n`;
    output += `${c.yellow}   List tooling gaps in Key Decisions (even "none found" counts).${c.reset}\n`;
  }

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
  snapshot,
  'pre-push-check': prePushCheck,
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
  snapshot         Output checks: YAML block for session log (run before logging)
  pre-push-check   Auto-verify + warn if completion < 25% (called by pre-push hook)

Options:
  --type=TYPE      Task type: content, infrastructure, bugfix, refactor, commands
  --issue=N        Auto-detect type from GitHub issue labels
  --na             Mark items as N/A [~] instead of checked [x] (for \`check\`)
  --reason=TEXT    Required with --na: short explanation why the item is not applicable
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
  crux agent-checklist check --na fix-escaping --reason "pure TypeScript change, no MDX files"
  crux agent-checklist verify
  crux agent-checklist status
  crux agent-checklist complete
  crux agent-checklist snapshot   # Output checks: YAML for session log

Checklist markers:
  [x]  Checked (complete)
  [ ]  Unchecked (incomplete)
  [~]  N/A (not applicable — counts as passing)

Slash commands:
  /agent-session-start      Runs \`crux agent-checklist init\` and presents the checklist
  /agent-session-ready-PR   Runs \`crux agent-checklist status\`, completes items, ships
`;
}
