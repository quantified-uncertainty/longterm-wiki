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
import { githubApi, REPO } from '../lib/github.ts';

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

interface GitHubIssue {
  number: number;
  state: string;
  title: string;
  labels: Array<{ name: string }>;
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
    const byLabel = await githubApi<GitHubIssue[]>(
      `/repos/${REPO}/issues?labels=wellness&state=open&per_page=5`,
    );
    if (byLabel.length > 0) {
      return byLabel[0].number;
    }

    // Fallback: search recent open issues by title prefix
    const recent = await githubApi<GitHubIssue[]>(
      `/repos/${REPO}/issues?state=open&per_page=30&sort=created&direction=desc`,
    );
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

    const openIssues = await githubApi<GitHubIssue[]>(
      `/repos/${REPO}/issues?labels=wellness&state=open&per_page=10`,
    );

    if (openIssues.length <= 1) return;

    // Keep the oldest (lowest number), close the rest
    const sorted = [...openIssues].sort((a, b) => a.number - b.number);
    const keeper = sorted[0];

    for (const issue of sorted.slice(1)) {
      try {
        await githubApi(`/repos/${REPO}/issues/${issue.number}/comments`, {
          method: 'POST',
          body: {
            body: `Closing as duplicate of #${keeper.number} (created by concurrent wellness check workflow).`,
          },
        });
        await githubApi(`/repos/${REPO}/issues/${issue.number}`, {
          method: 'PATCH',
          body: { state: 'closed' },
        });
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

/**
 * Ensure the "wellness" label exists on the repo.
 * No-ops if it already exists (409 Conflict).
 */
async function ensureWellnessLabel(): Promise<void> {
  try {
    await githubApi(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: {
        name: 'wellness',
        color: 'e4e669',
        description: 'Periodic wellness check failures',
      },
    });
  } catch (err) {
    // 422 = already exists — fine
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('422') && !msg.includes('already_exists')) {
      console.warn(`Warning: could not ensure wellness label: ${msg}`);
    }
  }
}

export async function manageWellnessIssue(
  report: WellnessReport,
  options: { runUrl?: string } = {},
): Promise<{ action: 'created' | 'updated' | 'closed' | 'none'; issueNumber?: number }> {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN not set — skipping wellness issue management');
    return { action: 'none' };
  }

  const existingIssue = await findOpenWellnessIssue();
  const runUrl = options.runUrl ?? '';

  if (!report.overallOk) {
    // ── Failure case ───────────────────────────────────────────────────
    await ensureWellnessLabel();

    if (existingIssue) {
      // Update existing issue with a comment
      const commentBody = runUrl
        ? `Wellness check still failing at ${report.timestamp}. See [run](${runUrl}) for details.`
        : `Wellness check still failing at ${report.timestamp}.`;

      await githubApi(`/repos/${REPO}/issues/${existingIssue}/comments`, {
        method: 'POST',
        body: { body: commentBody },
      });

      console.log(`Updated existing wellness issue #${existingIssue}`);
      return { action: 'updated', issueNumber: existingIssue };
    } else {
      // Create new issue with a stable title (no timestamp) so concurrent
      // workflows can find it via findOpenWellnessIssue(). The timestamp
      // is already in the issue body.
      const created = await githubApi<{ number: number }>(
        `/repos/${REPO}/issues`,
        {
          method: 'POST',
          body: {
            title: WELLNESS_ISSUE_TITLE,
            body: report.issueBody,
            labels: ['wellness', 'bug'],
          },
        },
      );

      // Best-effort dedup: close any duplicates from concurrent workflows
      await deduplicateWellnessIssues();

      console.log(`Created new wellness issue #${created.number}`);
      return { action: 'created', issueNumber: created.number };
    }
  } else {
    // ── All clear case ─────────────────────────────────────────────────
    if (existingIssue) {
      // Comment and close
      await githubApi(`/repos/${REPO}/issues/${existingIssue}/comments`, {
        method: 'POST',
        body: { body: `All wellness checks passed at ${report.timestamp}. Auto-closing.` },
      });

      await githubApi(`/repos/${REPO}/issues/${existingIssue}`, {
        method: 'PATCH',
        body: { state: 'closed' },
      });

      console.log(`Closed resolved wellness issue #${existingIssue}`);
      return { action: 'closed', issueNumber: existingIssue };
    } else {
      console.log('All checks passed. No open wellness issue to close.');
      return { action: 'none' };
    }
  }
}
