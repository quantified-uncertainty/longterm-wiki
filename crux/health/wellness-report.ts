/**
 * Wellness Report — Aggregate Reporting & GitHub Issue Management
 *
 * Collects CheckResult objects from all health checks and:
 *   1. Builds a markdown summary suitable for GitHub Actions step summary
 *   2. Builds an issue body with full details
 *   3. Manages GitHub issues: create, update (comment), or close
 *      based on whether the overall status improved or degraded.
 *
 * The "wellness" label is used to identify the tracking issue.
 * Only one open wellness issue exists at a time.
 */

import type { CheckResult } from './health-check.ts';
import {
  listIssuesByLabel,
  listRecentOpenIssues,
  createIssueComment,
  closeIssue,
  createIssue,
  ensureLabel,
  getGitHubToken,
  isMissingTokenError,
  MISSING_TOKEN_SUMMARY,
} from '../lib/github.ts';
import type { GitHubIssue } from '../lib/github.ts';
import {
  dedupLinearWellnessIssue,
  createLinearWellnessIssue,
  closeLinearWellnessOnAllClear,
  type CreateLinearWellnessResult,
  type LinearDedupDeps,
  type LinearWellnessAction,
} from './wellness-linear-dedup.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WellnessReport {
  timestamp: string;
  checks: CheckResult[];
  overallOk: boolean;
  markdownSummary: string;
  issueBody: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report building
// ─────────────────────────────────────────────────────────────────────────────

function statusIcon(ok: boolean): string {
  return ok ? ':green_circle:' : ':red_circle:';
}

export function buildWellnessReport(checks: CheckResult[]): WellnessReport {
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const overallOk = checks.every((c) => c.ok);

  // ── Markdown summary (for GitHub Actions step summary / stdout) ──────
  const summaryLines: string[] = [];
  summaryLines.push(`## Wellness Check — ${timestamp}`);
  summaryLines.push('');
  summaryLines.push('| Check | Status | Summary |');
  summaryLines.push('|-------|--------|---------|');
  for (const c of checks) {
    summaryLines.push(`| ${c.name} | ${statusIcon(c.ok)} | ${c.summary} |`);
  }
  summaryLines.push('');

  if (overallOk) {
    summaryLines.push(':white_check_mark: **All checks passed.**');
  } else {
    summaryLines.push(':x: **Some checks failed — see details below.**');
  }
  summaryLines.push('');

  // Add collapsible details for each check
  for (const c of checks) {
    if (c.detail && c.detail.length > 0) {
      summaryLines.push(`<details><summary>${c.name} details</summary>`);
      summaryLines.push('');
      for (const line of c.detail) {
        summaryLines.push(line);
      }
      summaryLines.push('');
      summaryLines.push('</details>');
      summaryLines.push('');
    }
  }

  const markdownSummary = summaryLines.join('\n');

  // ── Issue body (for GitHub issue creation) ───────────────────────────
  const issueLines: string[] = [];
  issueLines.push('## System Wellness Check Failed');
  issueLines.push('');
  issueLines.push('| Check | Status | Summary |');
  issueLines.push('|-------|--------|---------|');
  for (const c of checks) {
    issueLines.push(`| ${c.name} | ${statusIcon(c.ok)} | ${c.summary} |`);
  }
  issueLines.push('');
  issueLines.push(`**Detected at:** ${timestamp}`);
  issueLines.push('');

  // Add full details for each check
  for (const c of checks) {
    issueLines.push(`### ${c.name}`);
    issueLines.push('');
    if (c.detail && c.detail.length > 0) {
      for (const line of c.detail) {
        issueLines.push(line);
      }
    } else {
      issueLines.push(c.summary);
    }
    issueLines.push('');
  }

  issueLines.push('---');
  issueLines.push(
    '*Created by the wellness check workflows ([server-api-health](https://github.com/quantified-uncertainty/longterm-wiki/actions/workflows/server-api-health.yml), [frontend-data-health](https://github.com/quantified-uncertainty/longterm-wiki/actions/workflows/frontend-data-health.yml), [ci-pr-health](https://github.com/quantified-uncertainty/longterm-wiki/actions/workflows/ci-pr-health.yml)). Closes automatically when all checks pass.*',
  );

  const issueBody = issueLines.join('\n');

  return { timestamp, checks, overallOk, markdownSummary, issueBody };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub issue management
// ─────────────────────────────────────────────────────────────────────────────

export const WELLNESS_ISSUE_TITLE = 'System wellness check failing';

/**
 * Sentinel marker for the misconfig banner. Tests assert against this
 * verbatim; production code uses it via {@link prependMisconfigBanner}.
 */
export const MISCONFIG_BANNER_MARKER = '⚠️ **Wellness Linear-side dedup is DORMANT**';

/**
 * Prepend a banner explaining that this ticket is one of the duplicates the
 * Linear-side dedup was supposed to prevent (QUA-577 / QUA-667 / QUA-676), and
 * that the cure is to add the LINEAR_API_KEY secret. Keeps the banner above
 * the fold so the cause is visible in the Linear ticket preview too — Linear's
 * GitHub-mirror integration truncates aggressively.
 */
export function prependMisconfigBanner(body: string): string {
  const banner = [
    MISCONFIG_BANNER_MARKER,
    '',
    'The wellness-check workflow tried to dedup against existing Linear tickets',
    'but `LINEAR_API_KEY` is not set as a GitHub Actions secret in this repo.',
    'Until that secret is added, every close-then-reopen cycle of the wellness',
    'GitHub issue spawns a brand-new QUA ticket via Linear\'s GitHub integration.',
    '',
    '**Fix:** add the `LINEAR_API_KEY` secret at',
    '<https://github.com/quantified-uncertainty/longterm-wiki/settings/secrets/actions>',
    '(value lives in `lw/.env.base` at the workspace root). Reference: QUA-676.',
    '',
    '---',
    '',
  ].join('\n');
  return banner + body;
}

/**
 * Find the existing open wellness issue (if any).
 * Returns the issue number, or null if none exists.
 *
 * Uses a two-stage search: first by label (fast, indexed), then by title
 * prefix as fallback (catches cases where the label was manually removed).
 */
async function findOpenWellnessIssue(): Promise<number | null> {
  try {
    // Primary: search by label
    const byLabel = await listIssuesByLabel('wellness', 5);
    if (byLabel.length > 0) {
      return byLabel[0].number;
    }

    // Fallback: search recent open issues by title prefix
    const recent = await listRecentOpenIssues(30);
    const match = recent.find((i) => i.title.startsWith(WELLNESS_ISSUE_TITLE));
    if (match) {
      return match.number;
    }

    return null;
  } catch {
    // GitHub API failure — don't block the report
    return null;
  }
}

/**
 * Close duplicate wellness issues that were created by concurrent workflow runs.
 * Keeps the oldest (lowest number) and closes the rest as duplicates.
 */
async function deduplicateWellnessIssues(): Promise<void> {
  try {
    // Brief delay to let concurrent creates finish
    await new Promise((r) => setTimeout(r, 2000));

    const openIssues = await listIssuesByLabel('wellness', 10);

    if (openIssues.length <= 1) return;

    // Keep the oldest (lowest number), close the rest
    const sorted = [...openIssues].sort((a, b) => a.number - b.number);
    const keeper = sorted[0];

    for (const issue of sorted.slice(1)) {
      try {
        await createIssueComment(
          issue.number,
          `Closing as duplicate of #${keeper.number} (created by concurrent wellness check workflow).`,
        );
        await closeIssue(issue.number);
        console.log(`Closed duplicate wellness issue #${issue.number} (keeping #${keeper.number})`);
      } catch (err) {
        console.warn(
          `Failed to close duplicate #${issue.number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    // Best-effort dedup — don't fail the workflow over this
    console.warn(
      `Dedup check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function ensureWellnessLabel(): Promise<void> {
  await ensureLabel('wellness', 'e4e669', 'Periodic wellness check failures');
}

/**
 * Translate a `LinearWellnessAction` into a short-circuit result for
 * `manageWellnessIssue`, or return null when the caller should continue
 * to the GitHub create path.
 */
function handleLinearDedupAction(
  action: LinearWellnessAction,
): WellnessIssueResult | null {
  switch (action.kind) {
    case 'commented':
      console.log(`Commented on existing Linear wellness issue ${action.identifier}`);
      return { action: 'linear-commented', linearIdentifier: action.identifier };
    case 'reopened':
      console.log(`Reopened recent Linear wellness issue ${action.identifier}`);
      return { action: 'linear-reopened', linearIdentifier: action.identifier };
    case 'skipped':
      return null;
  }
}

/**
 * Translate a `CreateLinearWellnessResult` into a short-circuit result, or
 * return null when the caller should fall through to the GitHub create path.
 * `failed` always returns null so the caller's resilience fallback runs.
 */
function handleLinearCreateResult(
  result: CreateLinearWellnessResult,
): WellnessIssueResult | null {
  if (result.kind === 'created') {
    console.log(`Created new Linear wellness ticket ${result.identifier} (${result.url})`);
    return { action: 'linear-created', linearIdentifier: result.identifier };
  }
  return null;
}

export type WellnessIssueAction =
  | 'created'
  | 'updated'
  | 'closed'
  | 'none'
  | 'linear-commented'
  | 'linear-reopened'
  | 'linear-created';

export interface WellnessIssueResult {
  action: WellnessIssueAction;
  issueNumber?: number;
  linearIdentifier?: string;
}

export interface ManageWellnessOptions {
  runUrl?: string;
  /** Inject overrides for the Linear-side dedup path (used in tests). */
  linearDedupDeps?: Partial<LinearDedupDeps>;
}

export async function manageWellnessIssue(
  report: WellnessReport,
  options: ManageWellnessOptions = {},
): Promise<WellnessIssueResult> {
  // Probe GitHub availability without blocking the Linear-first path. A missing
  // token only disables GitHub operations — dedupLinearWellnessIssue /
  // createLinearWellnessIssue run regardless.
  let githubAvailable = true;
  try {
    getGitHubToken();
  } catch (e) {
    if (isMissingTokenError(e)) {
      console.warn(`${MISSING_TOKEN_SUMMARY} — GitHub issue management disabled`);
      githubAvailable = false;
    } else {
      throw e;
    }
  }

  // Skip the GitHub lookup when unavailable to avoid needless API noise;
  // findOpenWellnessIssue catches its own errors, but null is returned anyway.
  const existingIssue = githubAvailable ? await findOpenWellnessIssue() : null;
  const runUrl = options.runUrl ?? '';

  if (!report.overallOk) {
    // ── Failure case ───────────────────────────────────────────────────

    if (existingIssue) {
      // Update existing issue with a comment
      const commentBody = runUrl
        ? `Wellness check still failing at ${report.timestamp}. See [run](${runUrl}) for details.`
        : `Wellness check still failing at ${report.timestamp}.`;

      await createIssueComment(existingIssue, commentBody);

      console.log(`Updated existing wellness issue #${existingIssue}`);
      return { action: 'updated', issueNumber: existingIssue };
    }

    // No open GitHub issue. Check Linear for an existing open or recently
    // closed wellness ticket so we don't duplicate.
    // See QUA-577 for the 8-duplicate-tickets incident this prevents.
    const linearComment = runUrl
      ? `Wellness check failing again at ${report.timestamp}. See [run](${runUrl}) for details.`
      : `Wellness check failing again at ${report.timestamp}.`;
    const linearAction = await dedupLinearWellnessIssue(
      WELLNESS_ISSUE_TITLE,
      linearComment,
      options.linearDedupDeps,
    );
    const handled = handleLinearDedupAction(linearAction);
    if (handled) return handled;

    // Linear-first path (QUA-970): on `no-match` (Linear is healthy, just no
    // existing ticket), file the wellness ticket DIRECTLY in Linear — no
    // longer via the GitHub-mirror sync, which produced orphan tickets without
    // projects. The misconfig and lookup-failed reasons fall through to the
    // GitHub create below as a resilience fallback so a Linear outage doesn't
    // silently drop the alert entirely.
    let linearCreateResult: CreateLinearWellnessResult | null = null;
    if (linearAction.kind === 'skipped' && linearAction.reason === 'no-match') {
      linearCreateResult = await createLinearWellnessIssue(
        WELLNESS_ISSUE_TITLE,
        report.issueBody,
        options.linearDedupDeps,
      );
      const linearHandled = handleLinearCreateResult(linearCreateResult);
      if (linearHandled) return linearHandled;
      // Fell through: createLinearWellnessIssue returned a `failed` result.
      // Continue to the GitHub fallback below.
    }

    // GitHub fallback path. Reaches here when Linear is unreachable (misconfig,
    // transient outage, or project lookup/create failure). The misconfig case
    // (QUA-676) stamps an in-body banner so whoever reads the synced GitHub
    // mirror sees the cause + the fix path. The banner ONLY applies when the
    // underlying cause is the missing LINEAR_API_KEY secret — transient
    // lookup-failed/api-error reasons don't get the banner because the fix
    // (set the secret) doesn't apply.
    const misconfig =
      (linearAction.kind === 'skipped' && linearAction.reason === 'misconfig') ||
      (linearCreateResult?.kind === 'failed' && linearCreateResult.reason === 'misconfig');
    const issueBody = misconfig ? prependMisconfigBanner(report.issueBody) : report.issueBody;

    if (!githubAvailable) {
      console.warn('GitHub unavailable and Linear create did not produce a ticket — alert may be dropped');
      return { action: 'none' };
    }

    // ensureWellnessLabel is deferred here — only needed for GitHub issue creation.
    await ensureWellnessLabel();

    // Create new GitHub issue with a stable title (no timestamp) so concurrent
    // workflows can find it via findOpenWellnessIssue(). The timestamp is
    // already in the issue body.
    const created = await createIssue({
      title: WELLNESS_ISSUE_TITLE,
      body: issueBody,
      labels: ['wellness', 'bug'],
    });

    // Best-effort dedup: close any duplicates from concurrent workflows
    await deduplicateWellnessIssues();

    console.log(`Created new wellness issue #${created.number}`);
    return { action: 'created', issueNumber: created.number };
  } else {
    // ── All clear case ─────────────────────────────────────────────────
    if (existingIssue) {
      // Comment and close
      await createIssueComment(
        existingIssue,
        `All wellness checks passed at ${report.timestamp}. Auto-closing.`,
      );

      await closeIssue(existingIssue);

      console.log(`Closed resolved wellness issue #${existingIssue}`);
      return { action: 'closed', issueNumber: existingIssue };
    }

    // No open GitHub issue, but there may be an open Linear ticket that
    // we commented on during a prior failure (without creating GitHub).
    // Close it so Linear doesn't hold a hanging open ticket.
    const linearCloseResult = await closeLinearWellnessOnAllClear(
      WELLNESS_ISSUE_TITLE,
      `All wellness checks passed at ${report.timestamp}. Auto-closing.`,
      options.linearDedupDeps,
    );
    if (linearCloseResult.kind === 'closed') {
      const ids = linearCloseResult.identifiers.join(', ');
      console.log(`Closed Linear wellness ticket(s): ${ids}`);
      return { action: 'closed', linearIdentifier: linearCloseResult.identifiers[0] };
    }

    console.log('All checks passed. No open wellness issue to close.');
    return { action: 'none' };
  }
}
