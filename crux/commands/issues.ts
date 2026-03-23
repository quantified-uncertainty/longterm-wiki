/**
 * Issues Command Handlers
 *
 * Track Claude Code work on GitHub issues: list, prioritize, search, signal start/done.
 *
 * Usage:
 *   crux gh issues                      List open issues ranked by priority
 *   crux gh issues list                 Same as above
 *   crux gh issues next                 Show the single next issue to work on
 *   crux gh issues search <query>       Search existing issues before filing a new one
 *   crux gh issues comment <N> <msg>    Post a comment on an existing issue
 *   crux gh issues start <N>            Signal start: comment + add agent:working label
 *   crux gh issues done <N> [--pr=URL]  Signal completion: comment + remove label
 *   crux gh issues cleanup              Detect stale agent:working labels + potential duplicates
 *   crux gh issues close <N> [--reason] Close an issue with an optional comment
 */

import { readFileSync } from 'fs';
import { createLogger } from '../lib/output.ts';
import { githubApi, githubApiPaginated, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { parseIntOpt, parseRequiredInt } from '../lib/cli.ts';
import { listActiveAgents, registerAgent } from '../lib/wiki-server/active-agents.ts';
import { getAgentSessionByBranch, updateAgentSession, PR_OUTCOMES, type PrOutcome } from '../lib/wiki-server/agent-sessions.ts';
import { LABELS } from '../lib/labels.ts';

import type { GitHubIssueResponse, RankedIssue, ModelName } from '../lib/issues/types.ts';
import {
  CLAUDE_WORKING_LABEL,
  CLAUDE_WORKING_COLOR,
  CLAUDE_WORKING_DESC,
  SKIP_LABELS,
  MODEL_NAMES,
  MODEL_LABEL_PREFIX,
} from '../lib/issues/types.ts';
import { scoreIssue, issuePriority, isBlocked, rankIssues } from '../lib/issues/scoring.ts';
import { tokenize, scoreMatch } from '../lib/issues/search.ts';
import { findPotentialDuplicates } from '../lib/issues/dedup.ts';
import {
  checkIssueSections,
  buildIssueBody,
  mergeSections,
  formatScoreBreakdown,
  formatIssueRow,
} from '../lib/issues/formatting.ts';
import { extractModel, applyModelLabel, isValidModel } from '../lib/issues/models.ts';
import { DAILY_CREATE_LIMIT, getCreatesToday, recordCreate } from '../lib/issues/rate-limit.ts';

/**
 * Read a text value from a `--*-file=<path>` flag.
 * Returns null if the path is not provided or the file can't be read.
 */
function readFileFlag(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Error reading file ${path}: ${msg}`);
  }
}

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  json?: boolean;
  pr?: string;
  limit?: string;
  scores?: boolean;
  draft?: boolean;
  // create options
  model?: string;
  problem?: string;
  fix?: string;
  depends?: string;
  criteria?: string;
  cost?: string;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function ensureLabelExists(): Promise<void> {
  try {
    await githubApi<{ name: string }>(
      `/repos/${REPO}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`
    );
  } catch {
    // Label doesn't exist — create it
    await githubApi(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: {
        name: CLAUDE_WORKING_LABEL,
        color: CLAUDE_WORKING_COLOR,
        description: CLAUDE_WORKING_DESC,
      },
    });
  }
}

async function fetchOpenIssues(): Promise<RankedIssue[]> {
  // Paginate to fetch all open issues (GitHub returns max 100 per page) (#285)
  const data = await githubApiPaginated<GitHubIssueResponse>(
    `/repos/${REPO}/issues?state=open&per_page=100&sort=created&direction=asc`
  );

  return data
    .filter(i => !i.pull_request)
    .map(i => {
      const labels = (i.labels || []).map(l => l.name);
      const body = (i.body || '').trim();
      const breakdown = scoreIssue(labels, body, i.created_at, i.updated_at);
      return {
        number: i.number,
        title: i.title,
        body,
        labels,
        createdAt: i.created_at.slice(0, 10),
        updatedAt: i.updated_at.slice(0, 10),
        url: i.html_url,
        priority: issuePriority(labels),
        score: breakdown.total,
        scoreBreakdown: breakdown,
        inProgress: labels.includes(CLAUDE_WORKING_LABEL),
        blocked: isBlocked(labels, body),
        recommendedModel: extractModel(i.title, body, labels),
        missingSections: checkIssueSections(i.title, body, labels),
      };
    })
    .filter(i => !i.labels.some(l => SKIP_LABELS.has(l)));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List all open issues ranked by priority.
 */
async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const limit = parseIntOpt(options.limit, 30);
  const showScores = Boolean(options.scores);

  const issues = await fetchOpenIssues();
  const ranked = rankIssues(issues);
  const shown = ranked.slice(0, limit);
  const inProgress = issues.filter(i => i.inProgress);
  const blocked = ranked.filter(i => i.blocked && !i.inProgress);

  let output = '';
  output += `${c.bold}${c.blue}Open Issues (${issues.length})${c.reset}\n`;
  output += `${c.dim}Ranked by weighted score (priority + bug + effort + recency + age). `;
  output += `Use --scores to see score breakdowns.${c.reset}\n\n`;

  if (inProgress.length > 0) {
    output += `${c.bold}${c.yellow}In Progress (${inProgress.length}):${c.reset}\n`;
    for (const i of inProgress) {
      output += `${formatIssueRow(i, c, showScores)}\n`;
    }
    output += '\n';
  }

  if (blocked.length > 0) {
    output += `${c.bold}${c.red}Blocked (${blocked.length}):${c.reset}\n`;
    for (const i of blocked) {
      output += `${formatIssueRow(i, c, showScores)}\n`;
    }
    output += '\n';
  }

  const available = shown.filter(i => !i.inProgress && !i.blocked);
  output += `${c.bold}Queue:${c.reset}\n`;
  for (const issue of available) {
    output += `${formatIssueRow(issue, c, showScores)}\n`;
  }

  if (ranked.length > limit) {
    output += `\n${c.dim}...and ${ranked.length - limit} more. Use --limit=N to see more.${c.reset}\n`;
  }

  output += `\n${c.dim}Commands:${c.reset}\n`;
  output += `  ${c.dim}crux gh issues next        — show next issue to pick up${c.reset}\n`;
  output += `  ${c.dim}crux gh issues start <N>   — announce start + add label${c.reset}\n`;
  output += `  ${c.dim}crux gh issues done <N>    — announce completion + remove label${c.reset}\n`;

  if (options.json) {
    return { output: JSON.stringify(ranked, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Show the single next issue to work on (highest score, not in-progress, not blocked).
 */
async function next(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const showScores = Boolean(options.scores);

  const issues = await fetchOpenIssues();
  const ranked = rankIssues(issues);
  const available = ranked.filter(i => !i.inProgress && !i.blocked);

  if (available.length === 0) {
    const blockedCount = ranked.filter(i => i.blocked && !i.inProgress).length;
    const inProgressCount = issues.filter(i => i.inProgress).length;

    if (issues.length === 0) {
      return { output: `${c.yellow}No open issues found.${c.reset}\n`, exitCode: 0 };
    }

    let msg = `All ${issues.length} open issues are either:\n`;
    if (inProgressCount > 0) msg += `  • ${inProgressCount} labeled \`${CLAUDE_WORKING_LABEL}\` (in-flight)\n`;
    if (blockedCount > 0) msg += `  • ${blockedCount} blocked or waiting\n`;
    return { output: `${c.yellow}${msg}${c.reset}\n`, exitCode: 0 };
  }

  const top = available[0];

  let output = '';
  output += `${c.bold}${c.blue}Next Issue: #${top.number}${c.reset}\n\n`;
  output += `${c.bold}${top.title}${c.reset}\n`;
  output += `${c.dim}${top.url}${c.reset}\n`;

  if (top.labels.length > 0) {
    output += `Labels: ${top.labels.map(l => `${c.cyan}${l}${c.reset}`).join(', ')}\n`;
  }
  output += `Created: ${top.createdAt}\n`;

  if (showScores) {
    output += `Score: ${formatScoreBreakdown(top.scoreBreakdown, c)}\n`;
  }
  output += '\n';

  if (top.body) {
    const bodyPreview = top.body.length > 600 ? top.body.slice(0, 600) + '\n...(truncated)' : top.body;
    output += `${c.bold}Description:${c.reset}\n${bodyPreview}\n\n`;
  }

  const blockedIssues = ranked.filter(i => i.blocked && !i.inProgress);
  if (blockedIssues.length > 0) {
    output += `${c.dim}Blocked (${blockedIssues.length} issue${blockedIssues.length > 1 ? 's' : ''} waiting):${c.reset}\n`;
    for (const b of blockedIssues.slice(0, 3)) {
      output += `  ${c.dim}#${b.number}: ${b.title}${c.reset}\n`;
    }
    if (blockedIssues.length > 3) {
      output += `  ${c.dim}...and ${blockedIssues.length - 3} more${c.reset}\n`;
    }
    output += '\n';
  }

  if (available.length > 1) {
    output += `${c.dim}Also queued (${available.length - 1} more):${c.reset}\n`;
    for (const alt of available.slice(1, 4)) {
      output += `  ${c.dim}#${alt.number}: ${alt.title}${c.reset}\n`;
    }
    if (available.length > 4) {
      output += `  ${c.dim}...and ${available.length - 4} more${c.reset}\n`;
    }
    output += '\n';
  }

  output += `${c.bold}To start work:${c.reset}\n`;
  output += `  pnpm crux gh issues start ${top.number}\n`;

  if (options.json) {
    return { output: JSON.stringify(top, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Create a new GitHub issue.
 */
async function create(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const title = args[0];
  if (!title) {
    return {
      output: `${c.red}Usage: crux gh issues create <title> --model=haiku|sonnet|opus --criteria="item1|item2" [--label=X,Y] [--problem="..."] [--file=<path>] [--evidence="..."] [--fix="..."] [--depends=N,M] [--cost="~$2-4"] [--draft]${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Soft warning when creating many issues in a day
  {
    const todayCount = getCreatesToday();
    if (todayCount >= DAILY_CREATE_LIMIT) {
      process.stderr.write(
        `${c.yellow}⚠ You've created ${todayCount} issues today. Consider batching remaining items into one umbrella issue.${c.reset}\n`
      );
    }
  }

  const labels = options.label
    ? (options.label as string).split(',').map(l => l.trim()).filter(Boolean)
    : [];

  // --body-file takes precedence over --body (avoids shell expansion of backticks/dollars)
  // --problem-file takes precedence over --problem
  let bodyFromFile: string | undefined;
  let problemFromFile: string | undefined;
  try {
    bodyFromFile = readFileFlag((options['body-file'] ?? options.bodyFile) as string | undefined) ?? undefined;
    problemFromFile = readFileFlag((options['problem-file'] ?? options.problemFile) as string | undefined) ?? undefined;
  } catch (e: unknown) {
    return { output: `${c.red}${(e as Error).message}${c.reset}\n`, exitCode: 1 };
  }

  const effectiveBody = bodyFromFile ?? (options.body as string | undefined);
  const effectiveProblem = problemFromFile ?? (options.problem as string | undefined);

  // Validate model if specified
  if (options.model && !isValidModel(options.model as string)) {
    return {
      output: `${c.red}Invalid --model value: "${options.model}". Must be one of: ${MODEL_NAMES.join(', ')}${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Require --model and --criteria unless --draft or raw --body/--body-file is used
  if (!options.draft && !effectiveBody) {
    const missingFlags: string[] = [];
    if (!options.model) missingFlags.push('--model=haiku|sonnet|opus');
    if (!options.criteria) missingFlags.push('--criteria="item1|item2"');
    if (missingFlags.length > 0) {
      return {
        output:
          `${c.red}Missing required flag(s): ${missingFlags.join(', ')}${c.reset}\n` +
          `${c.dim}These flags are required to ensure issues pass formatting checks.\n` +
          `Use --draft to skip this validation for WIP issues.${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  // Require evidence of an observed problem (prevents speculative issue filing).
  if (!options.draft && !effectiveBody) {
    const hasEvidence = effectiveProblem || options.file || options.evidence;
    if (!hasEvidence) {
      return {
        output:
          `${c.red}Evidence required: agent-filed issues must reference a specific observation.${c.reset}\n` +
          `${c.dim}Use one of:\n` +
          `  --problem="Description of the observed issue"\n` +
          `  --file=<path>       File where the problem was observed\n` +
          `  --evidence="..."    Concrete error message or observation\n` +
          `Use --draft to skip this for WIP issues.${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  let body: string;
  if (effectiveBody) {
    body = effectiveBody;
  } else {
    const hasStructuredArgs = effectiveProblem || options.fix || options.depends || options.criteria || options.model;
    if (hasStructuredArgs) {
      body = buildIssueBody({
        problem: effectiveProblem,
        fix: typeof options.fix === 'string' ? options.fix : undefined,
        depends: options.depends as string | undefined,
        criteria: options.criteria as string | undefined,
        model: options.model as string | undefined,
        cost: options.cost as string | undefined,
        file: options.file as string | undefined,
        evidence: options.evidence as string | undefined,
      });
    } else {
      body = '';
    }
  }

  // Evidence validation: advisory warning if issue body lacks concrete evidence
  let evidenceWarning = '';
  if (body && !options.draft) {
    const hasCodeFence = /```/.test(body);
    const hasUrl = /https?:\/\//.test(body);
    const hasErrorOutput = /(?:output:|error:|stack trace|exception|failed)/i.test(body);
    const hasFilePath = /(?:\/[\w.-]+){2,}|[\w.-]+\.[a-z]{2,4}:\d+/.test(body);
    if (!hasCodeFence && !hasUrl && !hasErrorOutput && !hasFilePath) {
      evidenceWarning = `  ${c.yellow}⚠ Body lacks concrete evidence (no code fences, URLs, error output, or file paths)${c.reset}\n`;
    }
  }

  interface CreateIssueResponse {
    number: number;
    html_url: string;
    title: string;
  }

  const issue = await githubApi<CreateIssueResponse>(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: {
      title,
      ...(body ? { body } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    },
  });

  // Record creation for rate limiting (non-fatal)
  try { recordCreate(); } catch { /* ignore — rate limiting is advisory */ }

  // Apply model label if --model was specified
  if (options.model) {
    const modelName = (options.model as string).toLowerCase() as ModelName;
    await applyModelLabel(issue.number, modelName, labels);
  }

  // Apply agent:filed label for tracking agent-originated issues
  try {
    await githubApi(`/repos/${REPO}/issues/${issue.number}/labels`, {
      method: 'POST',
      body: { labels: [LABELS.AGENT_FILED] },
    });
  } catch { /* non-fatal — label might not exist yet */ }

  let output = '';
  const todayCount = getCreatesToday();
  output += `${c.green}✓${c.reset} Created issue #${issue.number}: ${issue.title}\n`;
  if (todayCount >= DAILY_CREATE_LIMIT) {
    output += `  ${c.dim}(${todayCount} issues created today)${c.reset}\n`;
  }
  output += `  ${c.cyan}${issue.html_url}${c.reset}\n`;
  const appliedLabels = options.model ? [...labels, `${MODEL_LABEL_PREFIX}${(options.model as string).toLowerCase()}`] : labels;
  if (appliedLabels.length > 0) {
    output += `  Labels: ${appliedLabels.join(', ')}\n`;
  }
  if (!body) {
    output += `  ${c.yellow}⚠ No body provided — consider adding --problem, --model, and --criteria flags${c.reset}\n`;
  } else {
    const missing = checkIssueSections(title, body);
    if (missing.length > 0) {
      output += `  ${c.yellow}⚠ Missing sections: ${missing.join(', ')}${c.reset}\n`;
      output += `  ${c.dim}Fix with: crux gh issues update-body ${issue.number} --problem="..." --model=sonnet --criteria="item1|item2"${c.reset}\n`;
    }
  }
  if (evidenceWarning) output += evidenceWarning;

  return { output, exitCode: 0 };
}

/**
 * Signal start of work: post a comment and add the agent:working label.
 */
async function start(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseRequiredInt(args[0]);
  if (!issueNum) {
    return {
      output: `${c.red}Usage: crux gh issues start <issue-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const branch = currentBranch();

  // Check for active-agent conflicts (best-effort — don't block if server is down)
  if (!options.force) {
    try {
      const result = await listActiveAgents('active');
      if (result.ok) {
        const conflicting = result.data.agents.filter(
          (a: { issueNumber: number | null; branch: string | null }) =>
            a.issueNumber === issueNum && a.branch !== branch
        );
        if (conflicting.length > 0) {
          let output = `${c.red}✗ Another agent is already working on issue #${issueNum}:${c.reset}\n`;
          for (const agent of conflicting) {
            output += `  ${c.yellow}→${c.reset} branch: ${c.cyan}${agent.branch ?? 'unknown'}${c.reset}`;
            output += `, started: ${new Date((agent as { startedAt: string }).startedAt).toISOString().slice(0, 16)}\n`;
          }
          output += `\n${c.dim}Use --force to override.${c.reset}\n`;
          return { output, exitCode: 1 };
        }
      }
    } catch {
      // Wiki-server may be unreachable — proceed without enforcement
    }
  }

  // Fetch issue details
  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);

  // Ensure label exists
  await ensureLabelExists();

  // Add the label
  await githubApi(`/repos/${REPO}/issues/${issueNum}/labels`, {
    method: 'POST',
    body: { labels: [CLAUDE_WORKING_LABEL] },
  });

  // Post start comment
  const body =
    `🤖 Claude Code starting work on this issue.\n\n` +
    `**Branch:** \`${branch}\`\n\n` +
    `Will post an update here when a PR is ready for review.`;

  await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
    method: 'POST',
    body: { body },
  });

  // Register as active agent (best-effort)
  try {
    await registerAgent({
      sessionId: `${branch}-${Date.now()}`,
      branch,
      task: issue.title,
      issueNumber: issueNum,
    });
  } catch {
    // Best-effort — GitHub tracking above is the primary mechanism
  }

  let output = '';
  output += `${c.green}✓${c.reset} Started tracking issue #${issueNum}: ${issue.title}\n`;
  output += `  Branch: ${c.cyan}${branch}${c.reset}\n`;
  output += `  Label \`${CLAUDE_WORKING_LABEL}\` added.\n`;
  output += `  Comment posted on ${issue.html_url}\n`;

  return { output, exitCode: 0 };
}

/**
 * Signal completion: post a comment and remove the agent:working label.
 */
async function done(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseRequiredInt(args[0]);
  if (!issueNum) {
    return {
      output: `${c.red}Usage: crux gh issues done <issue-number> [--pr=URL]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const prUrl = options.pr as string | undefined;
  const outcomeRaw = options.outcome as string | undefined;
  const fixesPrUrl = options['fixes-pr'] as string | undefined;

  // Validate outcome if provided
  let prOutcome: PrOutcome | undefined;
  if (outcomeRaw !== undefined) {
    if (!(PR_OUTCOMES as readonly string[]).includes(outcomeRaw)) {
      return {
        output: `${c.red}Invalid --outcome value: "${outcomeRaw}"\nValid values: ${PR_OUTCOMES.join(', ')}${c.reset}\n`,
        exitCode: 1,
      };
    }
    prOutcome = outcomeRaw as PrOutcome;
  }

  // Fetch issue details
  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);

  // Post completion comment on the issue
  let completionBody = prUrl
    ? `🤖 Claude Code has finished work on this issue.\n\n**PR ready for review:** ${prUrl}`
    : `🤖 Claude Code has finished work on this issue. A PR will be opened shortly.`;
  if (fixesPrUrl) {
    completionBody += `\n\n**Fix chain:** This PR fixes regressions introduced in ${fixesPrUrl}`;
  }

  await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
    method: 'POST',
    body: { body: completionBody },
  });

  // Remove the agent:working label (404 = label wasn't applied — that's fine)
  try {
    await githubApi(
      `/repos/${REPO}/issues/${issueNum}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('returned 404'))) throw err;
  }

  // If this PR is fixing a previous PR, post a comment on that PR too
  if (fixesPrUrl && prUrl) {
    const prNumMatch = fixesPrUrl.match(/\/pull\/(\d+)/);
    if (prNumMatch) {
      const originalPrNum = prNumMatch[1];
      const fixComment = `🤖 The regressions introduced in this PR have been fixed in ${prUrl}`;
      try {
        await githubApi(`/repos/${REPO}/issues/${originalPrNum}/comments`, {
          method: 'POST',
          body: { body: fixComment },
        });
      } catch (err) {
        // Best-effort: the original PR may be closed or inaccessible
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Could not post fix comment on original PR: ${msg}`);
      }
    }
  }

  // Record PR URL, outcome, and fix-chain in the agent session (best-effort)
  let sessionUpdated = false;
  const branch = currentBranch();
  if (branch && (prUrl || prOutcome !== undefined || fixesPrUrl)) {
    try {
      const sessionResult = await getAgentSessionByBranch(branch);
      if (sessionResult.ok) {
        const sessionUpdates: Record<string, unknown> = { status: 'completed' };
        if (prUrl) sessionUpdates.prUrl = prUrl;
        if (prOutcome !== undefined) sessionUpdates.prOutcome = prOutcome;
        if (fixesPrUrl) sessionUpdates.fixesPrUrl = fixesPrUrl;
        const updateResult = await updateAgentSession(sessionResult.data.id, sessionUpdates as Parameters<typeof updateAgentSession>[1]);
        sessionUpdated = updateResult.ok;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Could not update agent session: ${msg}`);
    }
  }

  let output = '';
  output += `${c.green}✓${c.reset} Marked issue #${issueNum} as done: ${issue.title}\n`;
  if (prUrl) output += `  PR: ${prUrl}\n`;
  if (fixesPrUrl) output += `  Fixes PR: ${fixesPrUrl}\n`;
  if (prOutcome) output += `  Outcome: ${prOutcome}\n`;
  output += `  Label \`${CLAUDE_WORKING_LABEL}\` removed.\n`;
  output += `  Comment posted on ${issue.html_url}\n`;
  if (sessionUpdated) {
    const parts: string[] = [];
    if (prUrl) parts.push('PR URL');
    if (fixesPrUrl) parts.push('fix-chain');
    if (prOutcome) parts.push('outcome');
    output += `  ${c.dim}Agent session updated with ${parts.join(', ')}.${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Detect stale agent:working labels and potential duplicate issues.
 */
async function cleanup(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const fix = Boolean(options.fix);

  const issues = await fetchOpenIssues();
  let output = '';
  let problemCount = 0;

  // --- 1. Stale agent:working labels ---
  const inProgress = issues.filter(i => i.inProgress);
  if (inProgress.length > 0) {
    output += `${c.bold}Checking ${inProgress.length} ${CLAUDE_WORKING_LABEL} issue(s) for stale labels...${c.reset}\n\n`;

    for (const issue of inProgress) {
      const comments = await githubApi<Array<{ body: string; created_at: string }>>(
        `/repos/${REPO}/issues/${issue.number}/comments?per_page=100&sort=created&direction=asc`
      );

      const branchPattern = /\*\*Branch:\*\*\s*`([^`]+)`/;
      let branchName: string | null = null;
      for (const comment of comments) {
        const match = comment.body.match(branchPattern);
        if (match) {
          branchName = match[1];
          break;
        }
      }

      if (!branchName) {
        output += `  ${c.yellow}⚠${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `    ${c.dim}No branch reference found in comments — may be stale${c.reset}\n`;
        problemCount++;
        continue;
      }

      // Check if branch exists on remote
      try {
        await githubApi(`/repos/${REPO}/branches/${encodeURIComponent(branchName)}`);
        output += `  ${c.green}✓${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `    ${c.dim}Branch ${branchName} exists${c.reset}\n`;
      } catch {
        output += `  ${c.red}✗${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `    ${c.dim}Branch ${branchName} does not exist — label is stale${c.reset}\n`;
        problemCount++;

        if (fix) {
          try {
            await githubApi(
              `/repos/${REPO}/issues/${issue.number}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
              { method: 'DELETE' }
            );
          } catch { /* 404 is fine */ }

          await githubApi(`/repos/${REPO}/issues/${issue.number}/comments`, {
            method: 'POST',
            body: {
              body: `Removing stale \`${CLAUDE_WORKING_LABEL}\` label — branch \`${branchName}\` no longer exists on remote. Issue is ready to be picked up again.`,
            },
          });
          output += `    ${c.green}→ Fixed: removed label and posted comment${c.reset}\n`;
        }
      }
    }
    output += '\n';
  } else {
    output += `${c.green}✓${c.reset} No ${CLAUDE_WORKING_LABEL} issues found.\n\n`;
  }

  // --- 2. Duplicate detection ---
  output += `${c.bold}Checking for potential duplicates...${c.reset}\n\n`;

  const duplicates = findPotentialDuplicates(issues);
  if (duplicates.length === 0) {
    output += `  ${c.green}✓${c.reset} No potential duplicates detected.\n`;
  } else {
    for (const dup of duplicates) {
      output += `  ${c.yellow}⚠${c.reset} Potential duplicate pair:\n`;
      output += `    #${dup.a.number}: ${dup.a.title}\n`;
      output += `    #${dup.b.number}: ${dup.b.title}\n`;
      output += `    ${c.dim}Similarity: ${(dup.similarity * 100).toFixed(0)}%${c.reset}\n\n`;
      problemCount++;
    }
  }

  // --- Summary ---
  output += '\n';
  if (problemCount === 0) {
    output += `${c.green}✓ All clean — no stale labels or duplicates found.${c.reset}\n`;
  } else {
    output += `${c.yellow}Found ${problemCount} issue(s) to review.${c.reset}\n`;
    if (!fix && inProgress.length > 0) {
      output += `${c.dim}Run with --fix to auto-remove stale ${CLAUDE_WORKING_LABEL} labels.${c.reset}\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Search open (and optionally closed) issues for potential matches to a query.
 */
async function search(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const query = args.join(' ').trim();
  if (!query) {
    return {
      output: `${c.red}Usage: crux gh issues search <query>${c.reset}\n` +
        `${c.dim}Example: crux gh issues search "dollar sign escaping in MDX"${c.reset}\n`,
      exitCode: 1,
    };
  }

  const includeClosed = Boolean(options.closed);
  const threshold = parseFloat((options.threshold as string) || '0.35');

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return {
      output: `${c.yellow}Query "${query}" produced no searchable tokens after stopword removal.${c.reset}\n` +
        `${c.dim}Tip: Use more specific terms. Short domain terms like CI, DX, PR, ID are recognized.${c.reset}\n`,
      exitCode: 1,
    };
  }

  // --- Search open issues ---
  const openIssues = await fetchOpenIssues();
  type Match = { number: number; title: string; url: string; state: string; score: number; labels: string[] };
  const matches: Match[] = [];

  for (const issue of openIssues) {
    const titleTokens = tokenize(issue.title);
    const bodyTokens = tokenize(issue.body.slice(0, 1500));
    const s = scoreMatch(queryTokens, titleTokens, bodyTokens);
    if (s >= threshold) {
      matches.push({ number: issue.number, title: issue.title, url: issue.url, state: 'open', score: s, labels: issue.labels });
    }
  }

  // --- Optionally search closed issues via GitHub search API ---
  if (includeClosed) {
    try {
      const searchQuery = encodeURIComponent(`repo:${REPO} is:issue is:closed ${query}`);
      const searchResults = await githubApi<{ items: GitHubIssueResponse[] }>(
        `/search/issues?q=${searchQuery}&per_page=20`
      );
      for (const item of searchResults.items) {
        if (matches.some(m => m.number === item.number)) continue;
        const titleTokens = tokenize(item.title);
        const bodyTokens = tokenize((item.body || '').slice(0, 1500));
        const s = scoreMatch(queryTokens, titleTokens, bodyTokens);
        if (s >= threshold) {
          matches.push({
            number: item.number,
            title: item.title,
            url: item.html_url,
            state: 'closed',
            score: s,
            labels: (item.labels || []).map(l => l.name),
          });
        }
      }
    } catch {
      // Search API failure is non-fatal
    }
  }

  matches.sort((a, b) => b.score - a.score);

  // --- Format output ---
  let output = '';
  output += `${c.bold}Search: "${query}"${c.reset}`;
  output += ` ${c.dim}(tokens: ${[...queryTokens].join(', ')})${c.reset}\n`;

  if (matches.length === 0) {
    output += `\n${c.yellow}No keyword matches found.${c.reset}\n`;
    output += `${c.dim}This search is keyword-based and may miss issues phrased differently.\n`;
    output += `If your topic is specific, also browse: crux gh issues list${c.reset}\n`;
    if (!includeClosed) {
      output += `${c.dim}Tip: Use --closed to also search closed issues.${c.reset}\n`;
    }
  } else {
    const strongMatches = matches.filter(m => m.score >= 0.6);
    const weakMatches = matches.filter(m => m.score < 0.6);

    if (strongMatches.length > 0) {
      output += `\n${c.yellow}Found ${strongMatches.length} likely match(es):${c.reset}\n\n`;
      for (const m of strongMatches.slice(0, 10)) {
        const stateTag = m.state === 'closed' ? `${c.dim}[closed]${c.reset} ` : '';
        const pct = `${(m.score * 100).toFixed(0)}%`;
        output += `  ${c.cyan}#${String(m.number).padEnd(5)}${c.reset} ${stateTag}${m.title}\n`;
        output += `    ${c.dim}Match: ${pct} — ${m.url}${c.reset}\n`;
      }
      output += `\n${c.bold}Check these before filing.${c.reset} Add a comment to an existing issue if it covers your concern.\n`;
    }

    if (weakMatches.length > 0) {
      if (strongMatches.length > 0) {
        output += `\n${c.dim}Also loosely related (${weakMatches.length}):${c.reset}\n`;
      } else {
        output += `\n${c.dim}Loosely related (low-confidence keyword overlap):${c.reset}\n`;
      }
      for (const m of weakMatches.slice(0, 5)) {
        const stateTag = m.state === 'closed' ? `[closed] ` : '';
        output += `  ${c.dim}#${String(m.number).padEnd(5)} ${stateTag}${m.title} (${(m.score * 100).toFixed(0)}%)${c.reset}\n`;
      }
      if (weakMatches.length > 5) {
        output += `  ${c.dim}...and ${weakMatches.length - 5} more${c.reset}\n`;
      }
      if (strongMatches.length === 0) {
        output += `\n${c.dim}These are weak keyword matches. Your issue may still be novel —\n`;
        output += `skim the titles above, but don't skip filing just because of low-confidence matches.${c.reset}\n`;
      }
    }
  }

  if (options.json) {
    return { output: JSON.stringify({ query, tokens: [...queryTokens], matches }, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Post a comment on an existing issue.
 */
async function comment(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseRequiredInt(args[0]);
  if (!issueNum) {
    return {
      output: `${c.red}Usage: crux gh issues comment <issue-number> <message>${c.reset}\n` +
        `${c.dim}Example: crux gh issues comment 42 "Found another instance in gate.ts:142"${c.reset}\n`,
      exitCode: 1,
    };
  }

  const bodyFromFile = readFileFlag(options['body-file'] as string | undefined);
  const message = bodyFromFile || args.slice(1).join(' ').trim() || (options.body as string) || '';
  if (!message) {
    return {
      output: `${c.red}No comment message provided.${c.reset}\n` +
        `${c.dim}Usage: crux gh issues comment <N> "your message"${c.reset}\n` +
        `${c.dim}   or: crux gh issues comment <N> --body-file=/tmp/comment.md${c.reset}\n`,
      exitCode: 1,
    };
  }

  let issue: GitHubIssueResponse;
  try {
    issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
  } catch {
    return {
      output: `${c.red}Issue #${issueNum} not found. Check the issue number.${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (issue.pull_request) {
    return {
      output: `${c.red}#${issueNum} is a pull request, not an issue. Use gh pr comment instead.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const branch = currentBranch();
  const attribution = branch ? `\n\n---\n*From session on branch \`${branch}\`*` : '';
  const fullBody = message + attribution;

  await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
    method: 'POST',
    body: { body: fullBody },
  });

  let output = '';
  output += `${c.green}Posted comment on #${issueNum}${c.reset}: ${issue.title}\n`;
  output += `${c.dim}https://github.com/${REPO}/issues/${issueNum}${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Close an issue with an optional comment and reason.
 */
async function close(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseRequiredInt(args[0]);
  if (!issueNum) {
    return {
      output: `${c.red}Usage: crux gh issues close <issue-number> [--reason="..."] [--duplicate=N]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const reason = (options.reason as string) || '';
  const duplicateOf = options.duplicate ? parseRequiredInt(options.duplicate as string) : null;
  if (options.duplicate && !duplicateOf) {
    return {
      output: `${c.red}Invalid --duplicate value: "${options.duplicate}". Must be a positive integer (issue number).${c.reset}\n`,
      exitCode: 1,
    };
  }

  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);

  if (reason || duplicateOf) {
    let body = '';
    if (duplicateOf) {
      body = `Closing as duplicate of #${duplicateOf}.`;
      if (reason) body += ` ${reason}`;
    } else {
      body = reason;
    }
    await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
      method: 'POST',
      body: { body },
    });
  }

  if (duplicateOf) {
    await githubApi(`/repos/${REPO}/issues/${issueNum}/labels`, {
      method: 'POST',
      body: { labels: ['duplicate'] },
    });
  }

  await githubApi(`/repos/${REPO}/issues/${issueNum}`, {
    method: 'PATCH',
    body: {
      state: 'closed',
      state_reason: duplicateOf ? 'not_planned' : 'completed',
    },
  });

  const labels = (issue.labels || []).map(l => l.name);
  if (labels.includes(CLAUDE_WORKING_LABEL)) {
    try {
      await githubApi(
        `/repos/${REPO}/issues/${issueNum}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
        { method: 'DELETE' }
      );
    } catch { /* 404 is fine */ }
  }

  let output = '';
  output += `${c.green}✓${c.reset} Closed issue #${issueNum}: ${issue.title}\n`;
  if (duplicateOf) output += `  Marked as duplicate of #${duplicateOf}\n`;
  if (reason) output += `  Comment: ${reason}\n`;

  return { output, exitCode: 0 };
}

/**
 * Update the body of an existing issue using structured template args.
 */
async function updateBody(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseRequiredInt(args[0]);
  if (!issueNum) {
    return {
      output: `${c.red}Usage: crux gh issues update-body <issue-number> [--body-file=path] [--model=haiku|sonnet|opus] [--problem="..."] [--fix="..."] [--depends=N,M] [--criteria="item1|item2"] [--cost="~$2-4"]${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (options.model && !isValidModel(options.model as string)) {
    return {
      output: `${c.red}Invalid --model value: "${options.model}". Must be one of: ${MODEL_NAMES.join(', ')}${c.reset}\n`,
      exitCode: 1,
    };
  }

  let bodyFromFile: string | undefined;
  let problemFromFile: string | undefined;
  try {
    bodyFromFile = readFileFlag((options['body-file'] ?? options.bodyFile) as string | undefined) ?? undefined;
    problemFromFile = readFileFlag((options['problem-file'] ?? options.problemFile) as string | undefined) ?? undefined;
  } catch (e: unknown) {
    return { output: `${c.red}${(e as Error).message}${c.reset}\n`, exitCode: 1 };
  }

  const effectiveProblem = problemFromFile ?? (options.problem as string | undefined);

  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
  const existingBody = (issue.body || '').trim();

  let combinedBody: string;

  if (bodyFromFile) {
    combinedBody = bodyFromFile;
  } else {
    const newBody = buildIssueBody({
      problem: effectiveProblem,
      fix: options.fix as string | undefined,
      depends: options.depends as string | undefined,
      criteria: options.criteria as string | undefined,
      model: options.model as string | undefined,
      cost: options.cost as string | undefined,
    });

    if (!newBody) {
      return {
        output: `${c.red}No structured args provided. Use --body-file, --problem, --fix, --model, --criteria, --depends, --cost.${c.reset}\n`,
        exitCode: 1,
      };
    }

    combinedBody = existingBody
      ? mergeSections(existingBody, newBody)
      : newBody;
  }

  await githubApi(`/repos/${REPO}/issues/${issueNum}`, {
    method: 'PATCH',
    body: { body: combinedBody },
  });

  const existingLabels = (issue.labels || []).map((l: { name: string }) => l.name);
  if (options.model) {
    const modelName = (options.model as string).toLowerCase() as ModelName;
    await applyModelLabel(issueNum, modelName, existingLabels);
  }

  const allLabels = options.model
    ? [...existingLabels.filter(l => !l.startsWith(MODEL_LABEL_PREFIX)), `${MODEL_LABEL_PREFIX}${(options.model as string).toLowerCase()}`]
    : existingLabels;

  const remaining = checkIssueSections(issue.title, combinedBody, allLabels);

  let output = `${c.green}✓${c.reset} Updated body for issue #${issueNum}: ${issue.title}\n`;
  output += `  ${c.cyan}${issue.html_url}${c.reset}\n`;
  if (options.model) {
    output += `  ${c.green}✓${c.reset} Applied label: ${MODEL_LABEL_PREFIX}${(options.model as string).toLowerCase()}\n`;
  }
  if (remaining.length === 0) {
    output += `  ${c.green}✓ Issue now has all required sections.${c.reset}\n`;
  } else {
    output += `  ${c.yellow}⚠ Still missing: ${remaining.join(', ')}${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Lint GitHub issues for formatting compliance.
 */
async function lint(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let issuesToCheck: Array<{ number: number; title: string; body: string; labels: string[]; url: string }>;

  const singleNum = parseRequiredInt(args[0]);

  if (singleNum) {
    const i = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${singleNum}`);
    if (i.pull_request) {
      return { output: `${c.red}#${singleNum} is a pull request, not an issue.${c.reset}\n`, exitCode: 1 };
    }
    issuesToCheck = [{ number: i.number, title: i.title, body: (i.body || '').trim(), labels: (i.labels || []).map(l => l.name), url: i.html_url }];
  } else {
    const issues = await fetchOpenIssues();
    issuesToCheck = issues.map(i => ({ number: i.number, title: i.title, body: i.body, labels: i.labels, url: i.url }));
  }

  interface LintResult {
    number: number;
    title: string;
    url: string;
    pass: boolean;
    model: string | null;
    missing: string[];
  }

  const results: LintResult[] = [];

  for (const issue of issuesToCheck) {
    const missing = checkIssueSections(issue.title, issue.body, issue.labels);
    const model = extractModel(issue.title, issue.body, issue.labels);
    results.push({ number: issue.number, title: issue.title, url: issue.url, pass: missing.length === 0, model, missing });
  }

  if (options.json) {
    const passCount = results.filter(r => r.pass).length;
    const failCount = results.filter(r => !r.pass).length;
    return {
      output: JSON.stringify({ pass: passCount, fail: failCount, issues: results }, null, 2),
      exitCode: failCount > 0 ? 1 : 0,
    };
  }

  let passCount = 0;
  let failCount = 0;
  let output = '';

  if (!singleNum) {
    output += `${c.bold}${c.blue}Issue Formatting Lint (${issuesToCheck.length} issues)${c.reset}\n\n`;
  }

  for (const r of results) {
    if (r.pass) {
      passCount++;
      if (singleNum) {
        output += `${c.green}✓ PASS${c.reset} #${r.number}: ${r.title}\n`;
        output += `  ${c.dim}${r.url}${c.reset}\n`;
        output += `  Recommended model: ${r.model ? `${c.cyan}${r.model}${c.reset}` : `${c.dim}(not specified)${c.reset}`}\n`;
      }
    } else {
      failCount++;
      output += `${c.red}✗ FAIL${c.reset} #${r.number}: ${r.title}\n`;
      output += `  ${c.dim}${r.url}${c.reset}\n`;
      for (const m of r.missing) {
        output += `  ${c.yellow}→ Missing: ${m}${c.reset}\n`;
      }
      if (!singleNum) output += '\n';
    }
  }

  if (!singleNum) {
    const total = issuesToCheck.length;
    output += `\n${c.bold}Summary:${c.reset} `;
    output += `${c.green}${passCount} pass${c.reset}, ${failCount > 0 ? `${c.red}${failCount} fail${c.reset}` : `${c.dim}0 fail${c.reset}`}`;
    output += ` (${total} total)\n`;

    if (failCount > 0) {
      output += `\n${c.dim}Fix with: crux gh issues update-body <N> --problem="..." --model=sonnet --criteria="item1|item2"${c.reset}\n`;
    }
  }

  return { output, exitCode: failCount > 0 ? 1 : 0 };
}

/**
 * Update the title of an existing issue.
 */
async function updateTitle(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseRequiredInt(args[0]);
  if (!issueNum) {
    return {
      output: `${c.red}Usage: crux gh issues update-title <issue-number> --title="New title"${c.reset}\n`,
      exitCode: 1,
    };
  }

  const newTitle = options.title as string | undefined;
  if (!newTitle) {
    return {
      output: `${c.red}Missing --title flag. Usage: crux gh issues update-title <N> --title="New title"${c.reset}\n`,
      exitCode: 1,
    };
  }

  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);

  await githubApi(`/repos/${REPO}/issues/${issueNum}`, {
    method: 'PATCH',
    body: { title: newTitle },
  });

  let output = `${c.green}✓${c.reset} Updated title for issue #${issueNum}\n`;
  output += `  ${c.dim}Old:${c.reset} ${issue.title}\n`;
  output += `  ${c.green}New:${c.reset} ${newTitle}\n`;
  output += `  ${c.cyan}${issue.html_url}${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  next,
  search,
  create,
  comment,
  'update-body': updateBody,
  'update-title': updateTitle,
  lint,
  start,
  done,
  cleanup,
  close,
};

export function getHelp(): string {
  return `
Issues Domain - Track Claude Code work on GitHub issues

Commands:
  list                List open issues ranked by priority (default)
  next                Show the single next issue to pick up
  search <query>      Search existing issues before filing a new one
  create <title>      Create a new GitHub issue (supports structured template)
  comment <N> <msg>   Post a comment on an existing issue
  update-body <N>     Update an issue body using structured template args
  update-title <N>    Update an issue title
  lint [N]            Check issue formatting (all issues, or single by number)
  start <N>           Signal start: post comment + add \`agent:working\` label
  done <N>            Signal completion: post comment + remove label
  cleanup             Detect stale agent:working labels + potential duplicates
  close <N>           Close an issue with optional comment

Options (list/next):
  --limit=N           Max issues to show in list (default: 30)
  --scores            Show score breakdown + formatting warnings per issue
  --json              JSON output

Options (search):
  --closed            Also search closed issues (via GitHub search API)
  --threshold=N       Minimum match score 0-1 (default: 0.35)
  --json              JSON output with match details

Options (comment):
  --body-file=<path>  Comment body from file (safe — avoids shell expansion)

Options (create):
  --label=X,Y         Comma-separated labels to apply
  --body="..."        Raw freeform body (bypasses --model/--criteria requirement)
  --body-file=<path>  Body from file (safe — avoids shell expansion of backticks/dollars)
  --problem="..."     Problem/background description (## Problem section)
  --problem-file=<path>  Problem from file (safe — avoids shell expansion)
  --fix="..."         Proposed fix or approach (## Proposed Fix section)
  --depends=N,M       Comma-separated dependent issue numbers
  --criteria="a|b|c"  Pipe-separated acceptance criteria items (REQUIRED)
  --model=haiku|sonnet|opus  Recommended model for this issue (REQUIRED)
  --cost="~$2-4"      Estimated AI cost
  --draft             Skip --model/--criteria validation (for WIP issues)

Options (update-title):
  --title="..."       New title for the issue (REQUIRED)

Options (update-body):
  --body-file=<path>  Set raw body directly (no merge — use for rich multi-section bodies)
  --problem="..."     Problem/background description (## Problem section)
  --problem-file=<path>  Problem from file (safe — avoids shell expansion)
  --fix="..."         Proposed fix or approach (## Proposed Fix section)
  --depends=N,M       Comma-separated dependent issue numbers
  --criteria="a|b|c"  Pipe-separated acceptance criteria items
  --model=haiku|sonnet|opus  Recommended model for this issue
  --cost="~$2-4"      Estimated AI cost

Options (done):
  --pr=URL            PR URL to include in the completion comment

Options (close):
  --reason="..."      Closing comment
  --duplicate=N       Close as duplicate of issue N

Options (cleanup):
  --fix               Auto-remove stale agent:working labels

Issue Formatting Standard:
  Well-formatted issues should have:
    1. ## Problem / ## Summary section (or long freeform body)
    2. ## Acceptance Criteria section or - [ ] checkboxes
    3. Recommended model: **Haiku/Sonnet/Opus** in ## Recommended Model section,
       or [haiku/sonnet/opus] suffix in the issue title
  Check compliance with: crux gh issues lint [N]

Scoring (weighted):
  Issues are ranked by a composite score combining:
    • Priority label: P0=1000, P1=500, P2=200, P3=100, unlabeled=50
    • Bug bonus: +50 for issues labeled 'bug', 'defect', 'regression', etc.
    • Claude-ready bonus: +50% for issues labeled 'claude-ready'
    • Effort adjustment: ±20 for effort:low / effort:high labels
    • Recency bonus: +15 if updated within 7 days
    • Age bonus: +1/month since creation (capped at +10)
  Blocked issues (labels: blocked/waiting/needs-info, or body text) are
  shown separately and excluded from the queue.

Examples:
  crux gh issues                        List all open issues
  crux gh issues --scores               List with score breakdowns + formatting warnings
  crux gh issues next                   Show next issue to pick up
  crux gh issues search "MDX escaping"  Check if issue exists before filing
  crux gh issues search "broken build" --closed   Also search closed issues
  crux gh issues comment 42 "Found another instance in gate.ts:142"
  crux gh issues lint                   Check all issues for formatting problems
  crux gh issues lint 239               Check single issue #239
  crux gh issues create "Add validation rule for X" --label=tooling \\
    --problem="X is not validated..." --model=haiku \\
    --criteria="Validation added|Tests pass|CI green" --cost="<$1"
  # For bodies with backticks/dollars/parens, use --problem-file or --body-file:
  crux gh issues create "Title" --problem-file=/tmp/problem.md --model=sonnet --criteria="a|b"
  crux gh issues update-body 239 --problem-file=/tmp/problem.md --model=sonnet --criteria="a|b"
  crux gh issues update-body 239 --body-file=/tmp/full-body.md  # Set raw body (no merge)
  crux gh issues start 239              Announce start (blocks if another agent is active)
  crux gh issues start 239 --force      Override conflict check
  crux gh issues done 239 --pr=https://github.com/.../pull/42
  crux gh issues cleanup                Check for stale labels and duplicates
  crux gh issues cleanup --fix          Auto-remove stale agent:working labels
  crux gh issues close 42 --duplicate=10
  crux gh issues close 42 --reason="Already done in PR #100"

Slash command:
  /next-issue    Claude Code command for the full "pick up next issue" workflow
`;
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { scoreIssue, isBlocked, findPotentialDuplicates, rankIssues, extractModel, checkIssueSections, buildIssueBody };
