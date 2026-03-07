/**
 * PR Patrol Output Formatting
 *
 * Terminal formatting for PR Patrol log data. Takes typed data from log-reader
 * and returns colorized strings using the shared output.ts color system.
 */

import type { Colors } from '../lib/output.ts';
import type {
  AggregatedStats,
  LogEntry,
  CycleSummaryEntry,
} from './log-reader.ts';

// ── Utilities ───────────────────────────────────────────────────────────────

/** Format a timestamp as relative time ("14m ago", "2h ago", "3d ago"). */
export function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format a timestamp as short datetime ("Mar 06 14:30"). */
function shortDateTime(timestamp: string): string {
  const d = new Date(timestamp);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${month} ${day} ${hour}:${min}`;
}

/** Simple horizontal bar chart using block characters. */
export function barChart(value: number, maxValue: number, maxWidth: number = 20): string {
  if (maxValue === 0 || value === 0) return '';
  const width = Math.round((value / maxValue) * maxWidth);
  return '\u2588'.repeat(Math.max(1, width));
}

/** Right-align a number in a fixed-width column. */
function rightAlign(n: number, width: number): string {
  return String(n).padStart(width);
}

/** Format percentage. */
function pct(n: number, total: number): string {
  if (total === 0) return '  -';
  return `${Math.round((n / total) * 100)}%`.padStart(4);
}

/** Format seconds as human-readable duration. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

// ── Outcome formatting ──────────────────────────────────────────────────────

function outcomeIcon(outcome: string, c: Colors): string {
  switch (outcome) {
    case 'fixed':
    case 'merged':
    case 'undrafted':
      return `${c.green}\u2713${c.reset}`;
    case 'max-turns':
      return `${c.yellow}\u26a0${c.reset}`;
    case 'timeout':
    case 'error':
      return `${c.red}\u2717${c.reset}`;
    case 'dry-run':
      return `${c.dim}~${c.reset}`;
    default:
      return ' ';
  }
}

function outcomeColor(outcome: string, c: Colors): string {
  switch (outcome) {
    case 'fixed':
    case 'merged':
    case 'undrafted':
      return c.green;
    case 'max-turns':
      return c.yellow;
    case 'timeout':
    case 'error':
      return c.red;
    case 'dry-run':
      return c.dim;
    default:
      return c.reset;
  }
}

// ── Status formatting ───────────────────────────────────────────────────────

/** Format entries grouped by cycle for the status/history view. */
export function formatStatus(entries: LogEntry[], c: Colors): string {
  if (entries.length === 0) return 'No PR Patrol logs found.\n';

  const lines: string[] = [
    `${c.bold}PR Patrol \u2014 Recent Activity${c.reset}`,
    `${c.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${c.reset}`,
    '',
  ];

  // Group entries by cycle. Entries between cycle_summary markers belong to that cycle.
  // We display in chronological order, with cycle headers.
  for (const entry of entries) {
    if (entry.type === 'cycle_summary') {
      lines.push(formatCycleHeader(entry, c));
    } else {
      lines.push(formatEntryLine(entry, c));
    }
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

function formatCycleHeader(entry: CycleSummaryEntry, c: Colors): string {
  const time = `${c.dim}${shortDateTime(entry.timestamp)}${c.reset}`;
  const queue = entry.queue_size > 0 ? `${c.yellow}queue=${entry.queue_size}${c.reset}` : `${c.dim}queue=0${c.reset}`;
  const mainFix = entry.main_branch_fix ? `  ${c.red}main-ci-fix${c.reset}` : '';
  return `  ${c.bold}${c.blue}Cycle #${entry.cycle_number}${c.reset}  ${time}  scanned=${entry.prs_scanned}  ${queue}${mainFix}`;
}

function formatEntryLine(entry: LogEntry, c: Colors): string {
  switch (entry.type) {
    case 'pr_result': {
      const icon = outcomeIcon(entry.outcome, c);
      const color = outcomeColor(entry.outcome, c);
      const issues = entry.issues?.length ? `  ${c.dim}${entry.issues.join(', ')}${c.reset}` : '';
      const time = entry.elapsed_s > 0 ? `  ${c.dim}(${formatDuration(entry.elapsed_s)})${c.reset}` : '';
      const reason = entry.reason ? `\n      ${c.dim}\u2192 ${entry.reason}${c.reset}` : '';
      return `    ${icon} PR #${entry.pr_num}  ${color}${entry.outcome}${c.reset}${time}${issues}${reason}`;
    }
    case 'merge_result': {
      const icon = outcomeIcon(entry.outcome, c);
      const color = outcomeColor(entry.outcome, c);
      const reason = entry.reason ? `  ${c.dim}(${entry.reason})${c.reset}` : '';
      return `    ${icon} PR #${entry.pr_num}  ${color}merge-${entry.outcome}${c.reset}${reason}`;
    }
    case 'main_branch_result': {
      const icon = outcomeIcon(entry.outcome, c);
      const color = outcomeColor(entry.outcome, c);
      const time = entry.elapsed_s > 0 ? `  ${c.dim}(${formatDuration(entry.elapsed_s)})${c.reset}` : '';
      return `    ${icon} Main branch  ${color}${entry.outcome}${c.reset}${time}  ${c.dim}run #${entry.run_id}${c.reset}`;
    }
    case 'overlap_warning':
      return `    ${c.yellow}\u26a0${c.reset} Overlap: PR #${entry.pr_a} \u2194 PR #${entry.pr_b}  ${c.dim}(${entry.shared_files} shared files)${c.reset}`;
    case 'undraft_result': {
      const icon = outcomeIcon(entry.outcome, c);
      const color = outcomeColor(entry.outcome, c);
      return `    ${icon} PR #${entry.pr_num}  ${color}undraft-${entry.outcome}${c.reset}`;
    }
    default:
      return '';
  }
}

// ── Stats formatting ────────────────────────────────────────────────────────

export function formatStats(stats: AggregatedStats, since: string, c: Colors): string {
  const lines: string[] = [
    `${c.bold}PR Patrol \u2014 Stats (last ${since})${c.reset}`,
    `${c.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${c.reset}`,
    '',
  ];

  // Cycles
  lines.push(`${c.bold}Cycles${c.reset}`);
  lines.push(`  Total:              ${rightAlign(stats.cycles.total, 5)}`);
  lines.push(`  Avg PRs scanned:    ${rightAlign(Math.round(stats.cycles.avgScanned * 10) / 10, 5)}`);
  lines.push(`  Avg queue size:     ${rightAlign(Math.round(stats.cycles.avgQueueSize * 10) / 10, 5)}`);
  lines.push('');

  // Fix outcomes
  if (stats.fixes.total > 0) {
    lines.push(`${c.bold}Fix Outcomes${c.reset}  ${c.dim}(${stats.fixes.total} total)${c.reset}`);
    const fixOrder = ['fixed', 'max-turns', 'timeout', 'error', 'dry-run'];
    for (const outcome of fixOrder) {
      const count = stats.fixes.byOutcome[outcome] ?? 0;
      if (count === 0) continue;
      const icon = outcomeIcon(outcome, c);
      const color = outcomeColor(outcome, c);
      lines.push(`  ${icon} ${color}${outcome.padEnd(12)}${c.reset} ${rightAlign(count, 3)}  (${pct(count, stats.fixes.total)})`);
    }
    lines.push('');
  }

  // Merge outcomes
  if (stats.merges.total > 0) {
    lines.push(`${c.bold}Merge Outcomes${c.reset}  ${c.dim}(${stats.merges.total} total)${c.reset}`);
    const mergeOrder = ['merged', 'error', 'dry-run'];
    for (const outcome of mergeOrder) {
      const count = stats.merges.byOutcome[outcome] ?? 0;
      if (count === 0) continue;
      const icon = outcomeIcon(outcome, c);
      const color = outcomeColor(outcome, c);
      lines.push(`  ${icon} ${color}${outcome.padEnd(12)}${c.reset} ${rightAlign(count, 3)}  (${pct(count, stats.merges.total)})`);
    }
    lines.push('');
  }

  // Issue types
  const issueEntries = Object.entries(stats.issueTypes).sort((a, b) => b[1] - a[1]);
  if (issueEntries.length > 0) {
    const maxIssueCount = issueEntries[0][1];
    lines.push(`${c.bold}Issue Types Fixed${c.reset}`);
    for (const [issue, count] of issueEntries) {
      const bar = `${c.cyan}${barChart(count, maxIssueCount, 15)}${c.reset}`;
      lines.push(`  ${issue.padEnd(20)} ${rightAlign(count, 3)}  ${bar}`);
    }
    lines.push('');
  }

  // Most-touched PRs (top 5 with 2+ attempts)
  const touchedPrs = [...stats.prTouched.entries()]
    .filter(([, info]) => info.attempts >= 2)
    .sort((a, b) => b[1].attempts - a[1].attempts)
    .slice(0, 5);
  if (touchedPrs.length > 0) {
    lines.push(`${c.bold}Most-Touched PRs${c.reset}`);
    for (const [prNum, info] of touchedPrs) {
      const abandoned = info.abandoned ? `  ${c.red}\u2190 abandoned${c.reset}` : '';
      lines.push(
        `  PR #${prNum}  \u2014 ${info.attempts} attempts (${info.issues.join(', ')})${abandoned}`,
      );
    }
    lines.push('');
  }

  // Performance
  if (stats.performance.avgFixTime > 0) {
    lines.push(`${c.bold}Performance${c.reset}`);
    lines.push(`  Avg fix time:       ${formatDuration(stats.performance.avgFixTime)}`);
    lines.push(`  Median fix time:    ${formatDuration(stats.performance.medianFixTime)}`);
    lines.push(
      `  Longest fix:        ${formatDuration(stats.performance.maxFixTime)}${stats.performance.maxFixPr ? ` (PR #${stats.performance.maxFixPr})` : ''}`,
    );
    lines.push('');
  }

  // Main branch
  if (stats.mainBranch.total > 0) {
    lines.push(`${c.bold}Main Branch CI${c.reset}  ${c.dim}(${stats.mainBranch.total} fixes)${c.reset}`);
    for (const [outcome, count] of Object.entries(stats.mainBranch.byOutcome)) {
      const icon = outcomeIcon(outcome, c);
      lines.push(`  ${icon} ${outcome}: ${count}`);
    }
    lines.push('');
  }

  // Overlaps
  if (stats.overlaps > 0) {
    lines.push(`${c.yellow}Overlap warnings: ${stats.overlaps}${c.reset}`);
    lines.push('');
  }

  // Undrafts
  if (stats.undrafts.total > 0) {
    lines.push(`${c.dim}Auto-undrafts: ${stats.undrafts.total}${c.reset}`);
    lines.push('');
  }

  if (stats.cycles.total === 0 && stats.fixes.total === 0) {
    lines.push(`${c.dim}No activity in the selected time window.${c.reset}`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ── Explain formatting ──────────────────────────────────────────────────────

export function formatExplain(c: Colors): string {
  return `${c.bold}PR Patrol \u2014 How It Works${c.reset}
${c.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${c.reset}

PR Patrol is a continuous daemon that scans open PRs for issues,
prioritizes them by severity, and spawns Claude CLI to fix the
highest-priority one each cycle.

${c.bold}Issue Types${c.reset} ${c.dim}(by priority score)${c.reset}
  ${c.red}conflict${c.reset}            ${c.dim}(100)${c.reset}  PR has merge conflicts with main
  ${c.red}ci-failure${c.reset}           ${c.dim}(80)${c.reset}   CI checks are failing
  ${c.yellow}bot-review-major${c.reset}    ${c.dim}(55)${c.reset}   Bot reviewers flagged critical/major issues
  ${c.yellow}missing-issue-ref${c.reset}   ${c.dim}(40)${c.reset}   PR body lacks "Closes #N" reference
  ${c.yellow}stale${c.reset}               ${c.dim}(30)${c.reset}   PR not updated in 48+ hours
  ${c.dim}missing-testplan${c.reset}    ${c.dim}(20)${c.reset}   PR body lacks "## Test plan" section
  ${c.dim}bot-review-nitpick${c.reset}  ${c.dim}(15)${c.reset}   Bot reviewers left minor nitpick comments

${c.bold}Scoring${c.reset}
  Issues are summed + age bonus (1 pt/hour, capped at 50).
  The highest-scoring PR is fixed each cycle.

${c.bold}Auto-Merge${c.reset}
  PRs labeled \`ready-to-merge\` are squash-merged when:
  ${c.green}\u2713${c.reset} CI is green (no failures or pending checks)
  ${c.green}\u2713${c.reset} No merge conflicts
  ${c.green}\u2713${c.reset} No unresolved review threads
  ${c.green}\u2713${c.reset} No unchecked checkboxes in PR body
  ${c.green}\u2713${c.reset} No \`claude-working\` label
  ${c.green}\u2713${c.reset} Not a draft (drafts are auto-undrafted first if eligible)

${c.bold}Safety${c.reset}
  Cooldown:     Each PR is skipped for 30 min after being processed
  Abandoned:    PRs that hit max-turns twice are abandoned permanently
  Main branch:  If main CI is red, that takes priority over the PR queue
  Overlaps:     Warns when 2+ PRs touch the same files

${c.bold}Log Files${c.reset}
  Runs:         ~/.cache/pr-patrol/runs.jsonl
  Reflections:  ~/.cache/pr-patrol/reflections.jsonl

${c.bold}Commands${c.reset}
  crux pr-patrol run              Start the daemon (continuous)
  crux pr-patrol once --dry-run   Preview what would happen
  crux pr-patrol status           Recent activity (colorized, filterable)
  crux pr-patrol history          Browse full log with time ranges
  crux pr-patrol stats            Aggregated metrics and success rates
  crux pr-patrol merge-status     Current merge eligibility (live)
  crux pr-patrol explain          This help text
`;
}
