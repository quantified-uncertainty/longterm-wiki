/**
 * Agent Checklist Command Handlers (simplified)
 *
 * Removed: active-agents registration, event logging, elaborate status formatting.
 * Kept: init, check, verify, status, complete, snapshot, pre-push-check.
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
  detectTypeFromLabels,
  checkItems,
  currentBranch,
  CHECKLIST_ITEMS,
  buildChecklistSnapshot,
  formatSnapshotAsYaml,
  type SessionType,
  type ChecklistMetadata,
} from '../lib/session/session-checklist.ts';
import type { CommandResult } from '../lib/cli.ts';
import { upsertAgentSession, updateAgentSession, getAgentSessionByBranch } from '../lib/wiki-server/agent-sessions.ts';
import { registerAgent, listActiveAgents } from '../lib/wiki-server/active-agents.ts';

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function init(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let type: SessionType = 'infrastructure';
  let task = args.filter(a => !a.startsWith('--')).join(' ') || '';
  let issue: number | undefined;

  if (options.issue) {
    const issueNum = parseInt(options.issue as string, 10);
    if (!issueNum || isNaN(issueNum)) {
      return { output: `${c.red}Invalid issue number: ${options.issue}${c.reset}\n`, exitCode: 1 };
    }
    issue = issueNum;

    try {
      const issueData = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
      const labels = issueData.labels.map(l => l.name);
      type = detectTypeFromLabels(labels);
      if (!task) task = issueData.title;
    } catch (err) {
      return { output: `${c.red}Failed to fetch issue #${issueNum}: ${(err as Error).message}${c.reset}\n`, exitCode: 1 };
    }
  }

  if (options.type) {
    const t = options.type as string;
    if (!VALID_TYPES.includes(t as SessionType)) {
      return { output: `${c.red}Invalid type: ${t}. Valid: ${VALID_TYPES.join(', ')}${c.reset}\n`, exitCode: 1 };
    }
    type = t as SessionType;
  }

  if (!task) {
    return { output: `${c.red}Usage: crux agent-checklist init "Task" --type=X | --issue=N${c.reset}\n`, exitCode: 1 };
  }

  const branch = currentBranch();
  const worktree = PROJECT_ROOT;
  const metadata: ChecklistMetadata = { task, branch, timestamp: new Date().toISOString(), issue };
  let markdown = buildChecklist(type, metadata);

  if (!issue) {
    const naResult = checkItems(markdown, ['issue-tracking'], '~', 'no GitHub issue for this session');
    markdown = naResult.markdown;
  }

  writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');

  // DB sync (best-effort)
  let dbSynced = false;
  let directoryWarning = '';
  try {
    const result = await upsertAgentSession({
      branch,
      task,
      sessionType: type,
      issueNumber: issue ?? null,
      checklistMd: markdown,
      worktree,
    });
    dbSynced = result.ok;

    // Auto-register as active agent for live tracking + collision detection
    await registerAgent({
      sessionId: branch,
      branch,
      task,
      issueNumber: issue ?? null,
      worktree,
    }).catch(() => {
      // Best-effort — active agent registration is non-critical
    });

    // Check for directory collisions with other active agents
    const agentsResult = await listActiveAgents('active', 100).catch(() => null);
    if (agentsResult?.ok) {
      const sameDir = agentsResult.data.agents.filter(
        (a) => a.worktree && a.worktree === worktree && a.sessionId !== branch
      );
      if (sameDir.length > 0) {
        directoryWarning = `\n${c.red}⚠ Directory collision: ${sameDir.length} other agent(s) in the same directory:${c.reset}\n`;
        for (const a of sameDir) {
          directoryWarning += `  ${c.red}-${c.reset} ${a.sessionId} (${a.task.slice(0, 60)})\n`;
        }
        directoryWarning += `  ${c.dim}This can cause file conflicts. Consider using a separate worktree.${c.reset}\n`;
      }
    }
  } catch {
    // Best-effort
  }

  const status = parseChecklist(markdown);
  let output = `${c.green}✓${c.reset} Agent checklist created: ${c.cyan}.claude/wip-checklist.md${c.reset}\n`;
  output += `  Type: ${c.bold}${type}${c.reset}\n`;
  output += `  Task: ${task}\n`;
  output += `  Branch: ${c.cyan}${branch}${c.reset}\n`;
  output += `  Directory: ${c.dim}${worktree}${c.reset}\n`;
  if (issue) output += `  Issue: ${c.cyan}#${issue}${c.reset}\n`;
  else output += `  ${c.dim}issue-tracking auto-marked N/A (no GitHub issue)${c.reset}\n`;
  output += `  Items: ${status.totalItems}\n`;
  if (dbSynced) output += `  ${c.dim}Synced to wiki-server DB${c.reset}\n`;
  if (directoryWarning) output += directoryWarning;
  output += `\n${c.dim}Run \`crux agent-checklist status\` to check progress.${c.reset}\n`;

  return { output, exitCode: 0 };
}

async function status(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return { output: `${c.yellow}No checklist found. Run \`crux agent-checklist init\` first.${c.reset}\n`, exitCode: 1 };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const s = parseChecklist(markdown);

  if (options.ci) {
    return { output: JSON.stringify({ totalChecked: s.totalChecked, totalItems: s.totalItems, allPassing: s.allPassing, decisions: s.decisions }, null, 2), exitCode: 0 };
  }

  const pct = s.totalItems > 0 ? Math.round((s.totalChecked / s.totalItems) * 100) : 0;
  const color = s.allPassing ? c.green : pct >= 50 ? c.yellow : c.red;
  let output = `${c.bold}Session Checklist${c.reset} ${color}${s.totalChecked}/${s.totalItems} (${pct}%)${c.reset}\n\n`;

  for (const item of s.items) {
    const isAdvisory = CHECKLIST_ITEMS.find(ci => ci.id === item.id)?.priority === 'advisory';
    const prefix = isAdvisory ? `${c.dim}(advisory)${c.reset} ` : '';
    if (item.status === 'checked') output += `  ${c.green}[x]${c.reset} ${prefix}${item.label}\n`;
    else if (item.status === 'na') output += `  ${c.dim}[~] ${prefix}${item.label} (N/A${item.naReason ? `: ${item.naReason}` : ''})${c.reset}\n`;
    else output += `  ${c.red}[ ]${c.reset} ${prefix}${item.label}\n`;
  }

  if (s.decisions.length > 0) {
    output += `\n${c.bold}Key Decisions (${s.decisions.length}):${c.reset}\n`;
    for (const d of s.decisions) output += `  ${c.cyan}-${c.reset} ${d}\n`;
  }

  return { output, exitCode: 0 };
}

async function complete(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return { output: `${c.red}No checklist found.${c.reset}\n`, exitCode: 1 };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const s = parseChecklist(markdown);

  if (s.allPassing) {
    let output = `${c.green}✓ All ${s.totalItems} checklist items complete!${c.reset}\n`;

    // Mark session as completed (best-effort)
    try {
      const branch = currentBranch();
      const sessionResult = await getAgentSessionByBranch(branch);
      if (sessionResult.ok && sessionResult.data.status === 'active') {
        await updateAgentSession(sessionResult.data.id, { status: 'completed' });
      }
    } catch {
      // Best-effort
    }

    output += `\n${c.dim}Ready to ship.${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  const unchecked = s.items.filter(i => i.status === 'unchecked');
  let output = `${c.red}✗ ${unchecked.length} unchecked item(s):${c.reset}\n`;
  for (const item of unchecked) output += `  ${c.red}[ ]${c.reset} ${item.label}\n`;
  output += `\n${c.dim}Complete all items or mark N/A before shipping.${c.reset}\n`;

  return { output, exitCode: 1 };
}

async function check(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return { output: `${c.red}No checklist found.${c.reset}\n`, exitCode: 1 };
  }

  const ids = args.filter(a => !a.startsWith('--'));
  if (typeof options.na === 'string') ids.push(options.na as string);
  if (ids.length === 0) {
    return { output: `${c.red}Usage: crux agent-checklist check <id> [id2 ...]${c.reset}\n`, exitCode: 1 };
  }

  const marker = options.na ? '~' as const : 'x' as const;
  const reason = typeof options.reason === 'string' ? options.reason.trim() : undefined;

  if (options.na && !reason) {
    return { output: `${c.red}--reason is required when marking N/A.${c.reset}\n`, exitCode: 1 };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const result = checkItems(markdown, ids, marker, reason);

  if (result.checked.length > 0) {
    writeFileSync(CHECKLIST_PATH, result.markdown, 'utf-8');
    await syncChecklistToDb(result.markdown);
  }

  let output = '';
  for (const id of result.checked) output += `  ${marker === 'x' ? `${c.green}[x]` : `${c.dim}[~]`}${c.reset} ${id}\n`;
  for (const id of result.notFound) output += `  ${c.red}???${c.reset} ${id} (not found)\n`;

  const updated = parseChecklist(result.checked.length > 0 ? result.markdown : markdown);
  output += `\n${c.dim}${updated.totalChecked}/${updated.totalItems} items complete${c.reset}\n`;

  return { output, exitCode: result.notFound.length > 0 ? 1 : 0 };
}

async function verify(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return { output: `${c.red}No checklist found.${c.reset}\n`, exitCode: 1 };
  }

  let markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const currentStatus = parseChecklist(markdown);
  const uncheckedIds = new Set(currentStatus.items.filter(i => i.status === 'unchecked').map(i => i.id));
  const verifiable = CHECKLIST_ITEMS.filter(item => item.verifyCommand && uncheckedIds.has(item.id));

  if (verifiable.length === 0) {
    return { output: `${c.dim}No unchecked items with auto-verify commands.${c.reset}\n`, exitCode: 0 };
  }

  let output = `${c.bold}Auto-verifying ${verifiable.length} items...${c.reset}\n`;
  const passed: string[] = [];

  for (const item of verifiable) {
    output += `  ${c.dim}▸${c.reset} ${item.label}... `;
    try {
      execSync(item.verifyCommand!, { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 300_000 });
      output += `${c.green}✓${c.reset}\n`;
      passed.push(item.id);
    } catch {
      output += `${c.red}✗${c.reset}\n`;
    }
  }

  if (passed.length > 0) {
    const result = checkItems(markdown, passed, 'x');
    markdown = result.markdown;
    writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');
    await syncChecklistToDb(markdown);
  }

  const updatedStatus = parseChecklist(markdown);
  output += `\n${c.dim}${updatedStatus.totalChecked}/${updatedStatus.totalItems} items complete${c.reset}\n`;

  return { output, exitCode: 0 };
}

async function snapshot(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    if (options.ci) return { output: JSON.stringify({ initialized: false }), exitCode: 0 };
    return { output: 'checks:\n  initialized: false\n', exitCode: 0 };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const snapshotData = buildChecklistSnapshot(markdown);

  if (options.ci) return { output: JSON.stringify(snapshotData, null, 2), exitCode: 0 };

  const yaml = formatSnapshotAsYaml(snapshotData);
  const pct = snapshotData.total ? Math.round(((snapshotData.completed ?? 0) / snapshotData.total) * 100) : 0;
  let output = yaml + '\n';
  output += `\n${pct === 100 ? c.green : c.yellow}${snapshotData.completed}/${snapshotData.total} items (${pct}%)${c.reset}\n`;

  return { output, exitCode: 0 };
}

async function prePushCheck(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) return { output: '', exitCode: 0 };

  let output = `${c.bold}Agent checklist checks...${c.reset}\n`;

  // Mark gate-passes as checked — we know the gate passed to reach this point
  let markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const preStatus = parseChecklist(markdown);
  const gateItem = preStatus.items.find(i => i.id === 'gate-passes');
  if (gateItem?.status === 'unchecked') {
    const result = checkItems(markdown, ['gate-passes'], 'x');
    markdown = result.markdown;
    writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');
    await syncChecklistToDb(markdown);
    output += `  ${c.green}✓${c.reset} gate-passes (auto-checked)\n`;
  }

  // Auto-verify remaining items
  const verifyResult = await verify([], options);
  output += verifyResult.output;

  // Check completion level
  markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const finalStatus = parseChecklist(markdown);
  const pct = finalStatus.totalItems > 0 ? Math.round((finalStatus.totalChecked / finalStatus.totalItems) * 100) : 0;

  const uncheckedBlocking = finalStatus.items.filter(i => {
    if (i.status !== 'unchecked') return false;
    const cat = CHECKLIST_ITEMS.find(ci => ci.id === i.id);
    return cat?.priority !== 'advisory';
  });

  if (pct < 40) {
    output += `\n${c.red}✗ Checklist only ${pct}% complete (minimum 40%). Run /agent-session-ready-PR before pushing.${c.reset}\n`;
    output += `${c.dim}  To bypass: git push --no-verify${c.reset}\n\n`;
    return { output, exitCode: 1 };
  }

  if (uncheckedBlocking.length > 5) {
    output += `\n${c.red}✗ ${uncheckedBlocking.length} blocking items unchecked. Run /agent-session-ready-PR before pushing.${c.reset}\n`;
    for (const item of uncheckedBlocking.slice(0, 5)) output += `  ${c.red}[ ]${c.reset} ${item.id}\n`;
    if (uncheckedBlocking.length > 5) output += `  ${c.dim}... and ${uncheckedBlocking.length - 5} more${c.reset}\n`;
    output += `${c.dim}  To bypass: git push --no-verify${c.reset}\n\n`;
    return { output, exitCode: 1 };
  }

  if (uncheckedBlocking.length > 0 && pct < 60) {
    output += `\n${c.yellow}⚠️  ${uncheckedBlocking.length} blocking item(s) unchecked:${c.reset}\n`;
    for (const item of uncheckedBlocking.slice(0, 5)) output += `  ${c.red}[ ]${c.reset} ${item.id}\n`;
    output += `${c.yellow}   Did you run /agent-session-ready-PR?${c.reset}\n\n`;
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
Agent Checklist — simplified session workflow tracking

Commands:
  init <task>      Generate a checklist (default)
  check <id>...    Check off items by ID
  verify           Auto-run verifiable items
  status           Show progress
  complete         Validate all items checked
  snapshot         Output checks: YAML for session log
  pre-push-check   Auto-verify + warn (called by pre-push hook)

Options:
  --type=TYPE      content | infrastructure | bugfix | refactor | commands
  --issue=N        Auto-detect type from GitHub issue labels
  --na             Mark items as N/A [~] (requires --reason)
  --reason=TEXT    Explanation for N/A
  --ci             JSON output

Examples:
  crux agent-checklist init "Add feature" --type=infrastructure
  crux agent-checklist init --issue=42
  crux agent-checklist check tests-written security
  crux agent-checklist check --na fix-escaping --reason "no MDX changes"
  crux agent-checklist verify
`;
}
