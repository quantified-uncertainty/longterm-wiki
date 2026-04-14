/**
 * Linear hygiene audit — read-only scan of the QUA team's open issues.
 *
 * Detects:
 *   - Orphans (open issues with no project)
 *   - Label hygiene (coverage %, singleton labels, over-labeled issues)
 *   - Assignee coverage
 *   - Priority coverage (unprioritized %)
 *   - Stuck "In Progress" issues (> N days since startedAt)
 *   - Thin tickets (<80 char description)
 *   - Open issue count per project
 *
 * Complements `lib/linear/audit.ts` which classifies In Progress issues
 * by PR health (shipped/orphan/epic/active). This module is about the
 * orthogonal dimension — metadata hygiene across ALL open issues.
 *
 * Derived from the 2026-04-14 refactor pass. See
 * `docs/audits/2026-04-14-linear-refactor.md` for the original findings.
 *
 * Usage:
 *   - CLI: `pnpm crux linear hygiene` (wired in `crux/commands/linear.ts`)
 *   - Programmatic: `import { runHygieneAudit } from '../lib/linear/hygiene.ts'`
 */

import { linearGraphQL } from './client.ts';
import type { Colors } from '../output.ts';

export interface HygieneIssue {
  identifier: string;
  title: string;
  priority: number;
  state: { name: string; type: string };
  project: { id: string; name: string } | null;
  assignee: { name: string } | null;
  labels: { nodes: { name: string }[] };
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
}

export interface HygieneReport {
  totalOpen: number;
  fetchedAt: string;

  // Orphans
  orphans: HygieneIssue[];

  // Labels
  issuesWithZeroLabels: number;
  issuesWithManyLabels: number; // ≥5 labels
  uniqueLabels: number;
  topLabels: Array<{ name: string; count: number }>;
  singletonLabels: string[];

  // Assignees
  unassignedCount: number;
  assigneeBreakdown: Array<{ name: string; count: number }>;

  // Priority
  priorityBreakdown: Array<{ priority: number; label: string; count: number }>;
  unprioritizedCount: number;

  // Stuck
  stuckInProgress: Array<{
    identifier: string;
    title: string;
    assignee: string;
    daysSinceStart: number;
  }>;

  // Thin tickets
  thinTicketCount: number;

  // Per-project counts
  openByProject: Array<{ name: string; count: number }>;
}

const PRIORITY_LABEL: Record<number, string> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};

type FetchedIssue = HygieneIssue & { description: string | null };

interface FetchResponse {
  team: {
    issues: {
      nodes: FetchedIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

async function fetchOpenIssues(teamId: string): Promise<FetchedIssue[]> {
  const all: FetchedIssue[] = [];
  let cursor: string | null = null;
  while (true) {
    const data: FetchResponse = await linearGraphQL<FetchResponse>(
      `query($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(
            first: 100
            after: $after
            filter: { state: { type: { nin: ["completed", "canceled"] } } }
          ) {
            nodes {
              identifier title priority description
              state { name type }
              project { id name }
              assignee { name }
              labels { nodes { name } }
              createdAt updatedAt startedAt
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId, after: cursor },
    );
    all.push(...data.team.issues.nodes);
    if (!data.team.issues.pageInfo.hasNextPage) break;
    cursor = data.team.issues.pageInfo.endCursor;
  }
  return all;
}

async function getQuaTeamId(): Promise<string> {
  const data = await linearGraphQL<{
    teams: { nodes: Array<{ id: string; key: string }> };
  }>(`query { teams { nodes { id key } } }`);
  const qua = data.teams.nodes.find((t) => t.key === 'QUA');
  if (!qua) throw new Error('QUA team not found in Linear workspace');
  return qua.id;
}

const STUCK_DAYS_THRESHOLD = 14;
const THIN_DESCRIPTION_CHARS = 80;
const DAY_MS = 1000 * 60 * 60 * 24;

export async function runHygieneAudit(): Promise<HygieneReport> {
  const teamId = await getQuaTeamId();
  const rawIssues = await fetchOpenIssues(teamId);

  const now = Date.now();

  // ── Orphans ──
  const orphans = rawIssues.filter((i) => !i.project);

  // ── Labels ──
  const issuesWithZeroLabels = rawIssues.filter((i) => i.labels.nodes.length === 0).length;
  const issuesWithManyLabels = rawIssues.filter((i) => i.labels.nodes.length >= 5).length;
  const labelCounts = new Map<string, number>();
  for (const issue of rawIssues) {
    for (const l of issue.labels.nodes) {
      labelCounts.set(l.name, (labelCounts.get(l.name) ?? 0) + 1);
    }
  }
  const topLabels = [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));
  const singletonLabels = [...labelCounts.entries()]
    .filter(([, c]) => c === 1)
    .map(([name]) => name)
    .sort();

  // ── Assignees ──
  const unassignedCount = rawIssues.filter((i) => !i.assignee).length;
  const assigneeCounts = new Map<string, number>();
  for (const i of rawIssues) {
    const name = i.assignee?.name ?? '(unassigned)';
    assigneeCounts.set(name, (assigneeCounts.get(name) ?? 0) + 1);
  }
  const assigneeBreakdown = [...assigneeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // ── Priority ──
  const priorityCounts = new Map<number, number>();
  for (const i of rawIssues) {
    priorityCounts.set(i.priority, (priorityCounts.get(i.priority) ?? 0) + 1);
  }
  const priorityBreakdown = [...priorityCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([priority, count]) => ({
      priority,
      label: PRIORITY_LABEL[priority] ?? String(priority),
      count,
    }));
  const unprioritizedCount = priorityCounts.get(0) ?? 0;

  // ── Stuck In Progress ──
  const stuckInProgress = rawIssues
    .filter((i) => i.state.type === 'started' && i.startedAt)
    .map((i) => ({
      identifier: i.identifier,
      title: i.title,
      assignee: i.assignee?.name ?? 'unassigned',
      daysSinceStart: Math.round((now - Date.parse(i.startedAt!)) / DAY_MS),
    }))
    .filter((i) => i.daysSinceStart > STUCK_DAYS_THRESHOLD)
    .sort((a, b) => b.daysSinceStart - a.daysSinceStart);

  // ── Thin tickets ──
  const thinTicketCount = rawIssues.filter(
    (i) => (i.description ?? '').trim().length < THIN_DESCRIPTION_CHARS,
  ).length;

  // ── Per-project ──
  const projectCounts = new Map<string, number>();
  for (const i of rawIssues) {
    const key = i.project?.name ?? '(orphan)';
    projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
  }
  const openByProject = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Strip `description` from orphans before returning — the report is
  // meant to be printed; we don't want giant bodies in the output.
  const orphansLite: HygieneIssue[] = orphans.map(({ description: _d, ...rest }) => rest);

  return {
    totalOpen: rawIssues.length,
    fetchedAt: new Date().toISOString(),
    orphans: orphansLite,
    issuesWithZeroLabels,
    issuesWithManyLabels,
    uniqueLabels: labelCounts.size,
    topLabels,
    singletonLabels,
    unassignedCount,
    assigneeBreakdown,
    priorityBreakdown,
    unprioritizedCount,
    stuckInProgress,
    thinTicketCount,
    openByProject,
  };
}

export function formatHygieneReport(r: HygieneReport, c: Colors): string {
  const lines: string[] = [];

  lines.push(`${c.bold}${c.blue}Linear Hygiene — QUA team${c.reset}`);
  lines.push(`${c.dim}Fetched: ${r.fetchedAt}${c.reset}`);
  lines.push('');
  lines.push(`Total open issues: ${c.bold}${r.totalOpen}${c.reset}`);
  lines.push('');

  // Orphans
  const orphansColor = r.orphans.length === 0 ? c.green : c.yellow;
  lines.push(`${c.bold}Orphans (no project):${c.reset} ${orphansColor}${r.orphans.length}${c.reset}`);
  if (r.orphans.length > 0) {
    for (const i of r.orphans.sort((a, b) => a.priority - b.priority)) {
      const pri = PRIORITY_LABEL[i.priority] ?? String(i.priority);
      lines.push(`  ${i.identifier}  ${pri}  [${i.state.name}]  ${i.title.slice(0, 72)}`);
    }
  }
  lines.push('');

  // Label hygiene
  const labelCoveragePct = Math.round(
    ((r.totalOpen - r.issuesWithZeroLabels) / Math.max(1, r.totalOpen)) * 100,
  );
  lines.push(`${c.bold}Label hygiene:${c.reset}`);
  lines.push(`  Issues with 0 labels: ${r.issuesWithZeroLabels}/${r.totalOpen}  (${100 - labelCoveragePct}% unlabeled)`);
  lines.push(`  Issues with ≥5 labels: ${r.issuesWithManyLabels}`);
  lines.push(`  Unique labels in use: ${r.uniqueLabels}`);
  if (r.topLabels.length > 0) {
    lines.push(`  Top labels:`);
    for (const { name, count } of r.topLabels.slice(0, 10)) {
      lines.push(`    ${count.toString().padStart(4)}  ${name}`);
    }
  }
  if (r.singletonLabels.length > 0) {
    lines.push(
      `  Singleton labels (used once — potential typo/cruft): ${r.singletonLabels.length}`,
    );
    if (r.singletonLabels.length <= 15) {
      lines.push(`    ${r.singletonLabels.join(', ')}`);
    }
  }
  lines.push('');

  // Assignees
  lines.push(`${c.bold}Assignees:${c.reset}`);
  lines.push(`  Unassigned: ${r.unassignedCount}/${r.totalOpen}`);
  for (const { name, count } of r.assigneeBreakdown) {
    lines.push(`    ${count.toString().padStart(4)}  ${name}`);
  }
  lines.push('');

  // Priority
  lines.push(`${c.bold}Priority:${c.reset}`);
  for (const { label, count } of r.priorityBreakdown) {
    lines.push(`    ${count.toString().padStart(4)}  ${label}`);
  }
  lines.push(`  Unprioritized: ${r.unprioritizedCount}/${r.totalOpen}`);
  lines.push('');

  // Stuck
  const stuckColor = r.stuckInProgress.length === 0 ? c.green : c.yellow;
  lines.push(
    `${c.bold}Stuck "In Progress" (>${STUCK_DAYS_THRESHOLD} days):${c.reset} ${stuckColor}${r.stuckInProgress.length}${c.reset}`,
  );
  for (const i of r.stuckInProgress) {
    lines.push(
      `  ${i.identifier}  ${i.daysSinceStart}d  ${i.assignee}  ${i.title.slice(0, 60)}`,
    );
  }
  lines.push('');

  // Thin tickets
  lines.push(
    `${c.bold}Thin tickets (< ${THIN_DESCRIPTION_CHARS} chars):${c.reset} ${r.thinTicketCount}`,
  );
  lines.push('');

  // Per-project
  lines.push(`${c.bold}Open by project:${c.reset}`);
  for (const { name, count } of r.openByProject) {
    lines.push(`    ${count.toString().padStart(4)}  ${name}`);
  }

  return lines.join('\n');
}
