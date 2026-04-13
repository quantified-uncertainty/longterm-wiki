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
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { upsertAgentSession, updateAgentSession, getAgentSessionByBranch } from '../lib/wiki-server/agent-sessions.ts';
import { registerAgent, listActiveAgents } from '../lib/wiki-server/active-agents.ts';
import { syncToMain } from '../lib/git.ts';
import { commands as issuesCommands } from './issues.ts';
import { commands as linearCommands, checkDedup as linearCheckDedup } from './linear.ts';
import { getIssue as getLinearIssue } from '../lib/linear/issues.ts';
import { getSessionContext } from '../lib/session/session-context.ts';
import { resolveLinearId, parseLinearId } from '../lib/linear/parse-id.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKLIST_PATH = join(PROJECT_ROOT, '.claude/wip-checklist.md');
const VALID_TYPES: SessionType[] = ['content', 'infrastructure', 'bugfix', 'refactor', 'commands'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  type?: string;
  issue?: string;
  /** Explicit Linear issue identifier, e.g. "QUA-184". If omitted, auto-detected
   *  from the branch name (claude/qua-NNN-*) and task description. */
  linear?: string;
  reason?: string;
  /** Skip the sync-to-main step. Used by tests and by scripted callers that
   *  intentionally want to start a session on the current branch. */
  noSync?: boolean;
  /** Skip the auto-call to `gh issues start <N>`. Used by tests. */
  noIssueStart?: boolean;
  /** Skip the auto-call to `linear issues start <QUA-NNN>`. Used by tests. */
  noLinearStart?: boolean;
  /** Pass --force through to `linear start` to bypass the dedup check. Also
   *  disarms the hard-fail path on dedup collisions. */
  force?: boolean;
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
    return { output: `${c.red}Usage: crux sys agent-checklist init "Task" --type=X | --issue=N${c.reset}\n`, exitCode: 1 };
  }

  // ── Sync to main ──────────────────────────────────────────────────────────
  // Programmatic replacement for the old "Step 0: sync with main" instructions
  // in /agent-init. Always runs unless explicitly opted out via --no-sync.
  // If the working tree is dirty, this aborts BEFORE writing the checklist —
  // the user must commit/stash/discard before retrying.
  let syncOutput = '';
  if (!options.noSync) {
    const sync = syncToMain();
    if (!sync.ok) {
      return {
        output:
          `${c.red}✗ Failed to sync to main:${c.reset}\n${sync.error}\n\n` +
          `${c.dim}If you intentionally want to start a session on the current branch ` +
          `(e.g. continuing work after a crash), re-run with --no-sync.${c.reset}\n`,
        exitCode: 1,
      };
    }
    for (const step of sync.steps) {
      syncOutput += `  ${c.dim}↻${c.reset} ${step}\n`;
    }
  }

  const branch = currentBranch();
  const worktree = PROJECT_ROOT;

  // Detect Linear issue ID: explicit --linear flag wins, else parse from branch + task.
  // Branch pattern: `claude/qua-184-description` → QUA-184. Task/description fallback
  // matches any bare QUA-NNN token. Returns null if neither source yields a match.
  let linearId: string | undefined = options.linear;
  if (!linearId) {
    const detected = resolveLinearId([branch, task]);
    if (detected) linearId = detected;
  }

  // ── Dedup pre-check ───────────────────────────────────────────────────────
  // If the issue is already claimed by another session, refuse to write ANY
  // local state (checklist, DB row, active-agent registration). Running this
  // BEFORE any file writes prevents half-initialized session state when two
  // agents race on the same ticket. See QUA-406.
  //
  // The check is gated on LINEAR_API_KEY being present (same conditions as
  // the later auto-call to `linear start`). If the key is missing or the
  // Linear API is unreachable, we fail-open — better than wedging init.
  if (
    linearId &&
    !options.noLinearStart &&
    !options.force &&
    process.env.LINEAR_API_KEY
  ) {
    try {
      const issue = await getLinearIssue(linearId);
      if (issue) {
        const ctx = getSessionContext();
        const collision = await linearCheckDedup(linearId, issue.url, ctx, c);
        if (collision) {
          return {
            output:
              `${c.red}✗ Refusing to initialize session — Linear ${linearId} is already claimed.${c.reset}\n\n` +
              collision.output +
              `\n${c.dim}Re-run with ${c.bold}--force${c.reset}${c.dim} to claim anyway:${c.reset}\n` +
              `  ${c.cyan}crux sys agent-checklist init ${args.map((a) => JSON.stringify(a)).join(' ')} --force${c.reset}\n`,
            exitCode: 2,
          };
        }
      }
    } catch {
      // Fail-open on pre-check errors (missing helper, network glitch).
      // The later `linear start` call will still run and post a start comment.
    }
  }

  // Warn if Linear ID detected but branch name doesn't encode it.
  // Linear's GitHub integration auto-moves issues on PR merge only when it can
  // link the PR — which requires the branch name to contain the issue ID.
  let linearBranchWarning = '';
  if (linearId && !parseLinearId(branch)) {
    const suggested = `claude/${linearId.toLowerCase()}-${task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/,'').slice(0, 40)}`;
    linearBranchWarning =
      `\n${c.yellow}⚠ Branch "${branch}" does not contain the Linear ID ${linearId}.${c.reset}\n` +
      `  Linear's GitHub integration won't auto-close the issue on PR merge.\n` +
      `  ${c.dim}Suggested: git checkout -b ${suggested}${c.reset}\n` +
      `  ${c.dim}Or: include "Fixes ${linearId}" in the PR description (done automatically by \`crux gh pr create\`).${c.reset}\n`;
  }

  // ── Preserve existing manual checks ────────────────────────────────────────
  // If a checklist already exists, read its checked/N/A items so they survive
  // re-initialization. Prevents the "reset on new commit" bug (#3906).
  let priorItems: ReturnType<typeof parseChecklist>['items'] | null = null;
  if (existsSync(CHECKLIST_PATH)) {
    priorItems = parseChecklist(readFileSync(CHECKLIST_PATH, 'utf-8')).items;
  }

  const metadata: ChecklistMetadata = { task, branch, timestamp: new Date().toISOString(), issue, linearId };
  let markdown = buildChecklist(type, metadata);

  if (!issue) {
    const naResult = checkItems(markdown, ['issue-tracking'], '~', 'no GitHub issue for this session');
    markdown = naResult.markdown;
  }

  // Reapply preserved checks from prior checklist in a single pass
  if (priorItems) {
    for (const item of priorItems) {
      const marker = item.status === 'checked' ? 'x' as const : item.status === 'na' ? '~' as const : null;
      if (marker) {
        const result = checkItems(markdown, [item.id], marker, item.naReason);
        if (result.checked.length > 0) markdown = result.markdown;
      }
    }
  }

  writeFileSync(CHECKLIST_PATH, markdown, 'utf-8');

  // DB sync (best-effort)
  let dbSynced = false;
  let directoryWarning = '';
  try {
    // QUA-440: persist linearId and slotNumber so the DB-first dedup query
    // and the internal dashboards can surface them without string-matching
    // task/checklist content. `ctx.slot` is derived from the `a<N>` ancestor
    // of the current working directory (see session-context.ts).
    const ctx = getSessionContext();
    const result = await upsertAgentSession({
      branch,
      task,
      sessionType: type,
      issueNumber: issue ?? null,
      linearId: linearId ?? null,
      slotNumber: ctx.slot,
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
    }).catch((e: unknown) => {
      // Best-effort — active agent registration is non-critical.
      // Wiki-server may be unreachable; agent-checklist still works locally.
      console.warn(`Active agent registration failed: ${e instanceof Error ? e.message : String(e)}`);
    });

    // Check for directory collisions with other active/stale agents.
    // Include stale agents — they may still be running (just missed a heartbeat).
    const agentsResult = await listActiveAgents(undefined, 100).catch((e: unknown) => {
      // Best-effort — collision detection is non-critical
      console.warn(`Directory collision check failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (agentsResult?.ok) {
      const sameDir = agentsResult.data.agents.filter(
        (a) => a.worktree && a.worktree === worktree
          && a.sessionId !== branch
          && (a.status === 'active' || a.status === 'stale')
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

  // ── Auto-call `gh issues start <N>` ───────────────────────────────────────
  // Programmatic replacement for the old "Step 2: signal start on issue"
  // instructions in /agent-init. Best-effort: failure here (e.g. GitHub down,
  // wiki-server down, label conflict) does NOT fail the init — the local
  // checklist is already on disk and that's the important state.
  let issueStartOutput = '';
  if (issue && !options.noIssueStart) {
    try {
      const startResult = await issuesCommands.start(
        [String(issue)],
        { ci: options.ci },
      );
      if (startResult.exitCode === 0) {
        issueStartOutput = startResult.output;
      } else {
        issueStartOutput =
          `${c.yellow}⚠ Auto-start of issue #${issue} returned non-zero exit:${c.reset}\n` +
          startResult.output +
          `${c.dim}(checklist created locally; you may want to run ` +
          `\`crux gh issues start ${issue}\` manually)${c.reset}\n`;
      }
    } catch (e) {
      issueStartOutput =
        `${c.yellow}⚠ Could not signal start on issue #${issue}: ` +
        `${e instanceof Error ? e.message : String(e)}${c.reset}\n` +
        `${c.dim}(checklist created locally)${c.reset}\n`;
    }
  }

  // ── Auto-call `linear issues start <QUA-NNN>` ────────────────────────────
  // Dedup collisions (exit code 2) are hard-fail: the checklist is NOT
  // written, and init returns non-zero so the user sees the collision
  // before committing to a session. All other errors (missing key, network
  // glitch, issue-not-found) remain best-effort warnings — we don't want
  // a transient API blip to wedge every init.
  let linearStartOutput = '';
  if (linearId && !options.noLinearStart) {
    if (!process.env.LINEAR_API_KEY) {
      linearStartOutput =
        `${c.dim}Linear ID ${linearId} detected but LINEAR_API_KEY is not set — ` +
        `skipping auto-start. Sync .env.base or export the key to enable.${c.reset}\n`;
    } else {
      try {
        const startResult = await linearCommands.start(
          [linearId],
          { ci: options.ci, force: options.force },
        );
        if (startResult.exitCode === 0) {
          linearStartOutput = startResult.output;
        } else if (startResult.exitCode === 2) {
          // Dedup collision — refuse to create the checklist. The start
          // output contains a rich diagnostic (active claims + open PRs)
          // that tells the user exactly what's blocking them.
          return {
            output:
              `${c.red}✗ Refusing to create session checklist — Linear ${linearId} is already claimed.${c.reset}\n\n` +
              startResult.output +
              `\n${c.dim}Re-run with ${c.bold}--force${c.reset}${c.dim} to claim anyway:${c.reset}\n` +
              `  ${c.cyan}crux sys agent-checklist init ${args.map((a) => JSON.stringify(a)).join(' ')} --force${c.reset}\n`,
            exitCode: 2,
          };
        } else {
          linearStartOutput =
            `${c.yellow}⚠ Auto-start of Linear ${linearId} returned non-zero exit:${c.reset}\n` +
            startResult.output +
            `${c.dim}(checklist created locally; you may want to run ` +
            `\`crux linear issues start ${linearId}\` manually)${c.reset}\n`;
        }
      } catch (e) {
        linearStartOutput =
          `${c.yellow}⚠ Could not signal start on Linear ${linearId}: ` +
          `${e instanceof Error ? e.message : String(e)}${c.reset}\n` +
          `${c.dim}(checklist created locally)${c.reset}\n`;
      }
    }
  }

  const status = parseChecklist(markdown);
  let output = '';
  if (syncOutput) {
    output += `${c.bold}Synced to main${c.reset}\n${syncOutput}\n`;
  }
  output += `${c.green}✓${c.reset} Agent checklist created: ${c.cyan}.claude/wip-checklist.md${c.reset}\n`;
  output += `  Type: ${c.bold}${type}${c.reset}\n`;
  output += `  Task: ${task}\n`;
  output += `  Branch: ${c.cyan}${branch}${c.reset}\n`;
  output += `  Directory: ${c.dim}${worktree}${c.reset}\n`;
  if (issue) output += `  Issue: ${c.cyan}#${issue}${c.reset}\n`;
  else output += `  ${c.dim}issue-tracking auto-marked N/A (no GitHub issue)${c.reset}\n`;
  if (linearId) output += `  Linear: ${c.cyan}${linearId}${c.reset}\n`;
  output += `  Items: ${status.totalItems}\n`;
  if (dbSynced) output += `  ${c.dim}Synced to wiki-server DB${c.reset}\n`;
  if (directoryWarning) output += directoryWarning;
  if (linearBranchWarning) output += linearBranchWarning;
  if (issueStartOutput) output += `\n${issueStartOutput}`;
  if (linearStartOutput) output += `\n${linearStartOutput}`;

  // Render the full checklist so callers don't need a separate `status` call.
  output += `\n${renderChecklistItems(status, c)}`;

  return { output, exitCode: 0 };
}

/**
 * Render the checklist items as colored text. Shared between `init` and `status`
 * so they format identically.
 */
function renderChecklistItems(
  s: ReturnType<typeof parseChecklist>,
  c: ReturnType<typeof createLogger>['colors'],
): string {
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
  return output;
}

async function status(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (!existsSync(CHECKLIST_PATH)) {
    return { output: `${c.yellow}No checklist found. Run \`crux sys agent-checklist init --issue=N\` or \`crux sys agent-checklist init "task description"\` first.${c.reset}\n`, exitCode: 1 };
  }

  const markdown = readFileSync(CHECKLIST_PATH, 'utf-8');
  const s = parseChecklist(markdown);

  if (options.ci) {
    return { output: JSON.stringify({ totalChecked: s.totalChecked, totalItems: s.totalItems, allPassing: s.allPassing, decisions: s.decisions }, null, 2), exitCode: 0 };
  }

  return { output: renderChecklistItems(s, c), exitCode: 0 };
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
    return { output: `${c.red}Usage: crux sys agent-checklist check <id> [id2 ...]${c.reset}\n`, exitCode: 1 };
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
    output += `\n${c.red}✗ Checklist only ${pct}% complete (minimum 40%). Run /agent-ship before pushing.${c.reset}\n`;
    output += `${c.dim}  To bypass: git push --no-verify${c.reset}\n\n`;
    return { output, exitCode: 1 };
  }

  if (uncheckedBlocking.length > 5) {
    output += `\n${c.red}✗ ${uncheckedBlocking.length} blocking items unchecked. Run /agent-ship before pushing.${c.reset}\n`;
    for (const item of uncheckedBlocking.slice(0, 5)) output += `  ${c.red}[ ]${c.reset} ${item.id}\n`;
    if (uncheckedBlocking.length > 5) output += `  ${c.dim}... and ${uncheckedBlocking.length - 5} more${c.reset}\n`;
    output += `${c.dim}  To bypass: git push --no-verify${c.reset}\n\n`;
    return { output, exitCode: 1 };
  }

  if (uncheckedBlocking.length > 0 && pct < 60) {
    output += `\n${c.yellow}⚠️  ${uncheckedBlocking.length} blocking item(s) unchecked:${c.reset}\n`;
    for (const item of uncheckedBlocking.slice(0, 5)) output += `  ${c.red}[ ]${c.reset} ${item.id}\n`;
    output += `${c.yellow}   Did you run /agent-ship?${c.reset}\n\n`;
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
  crux sys agent-checklist init "Add feature" --type=infrastructure
  crux sys agent-checklist init --issue=42
  crux sys agent-checklist check tests-written security
  crux sys agent-checklist check --na fix-escaping --reason "no MDX changes"
  crux sys agent-checklist verify
`;
}
