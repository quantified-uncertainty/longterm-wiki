import { IssuesTable } from "./issues-table";
import type { IssueRow } from "./types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GitHub Issues | Longterm Wiki Internal",
  description:
    "Live view of GitHub issues: claude-working queue and priority-ranked backlog.",
};

const REPO = "quantified-uncertainty/longterm-wiki";
const CLAUDE_WORKING_LABEL = "claude-working";
const SKIP_LABELS = new Set([
  "wontfix",
  "on-hold",
  "invalid",
  "duplicate",
  "won't fix",
]);

const PRIORITY_LABELS: Record<string, number> = {
  P0: 0,
  p0: 0,
  "priority:critical": 0,
  P1: 1,
  p1: 1,
  "priority:high": 1,
  P2: 2,
  p2: 2,
  "priority:medium": 2,
  P3: 3,
  p3: 3,
  "priority:low": 3,
};

interface GitHubIssueResponse {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

function issuePriority(labels: string[]): number {
  let best = 99;
  for (const label of labels) {
    const p = PRIORITY_LABELS[label];
    if (p !== undefined && p < best) best = p;
  }
  return best;
}

async function fetchIssues(): Promise<IssueRow[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/issues?state=open&per_page=100&sort=created&direction=asc`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
        next: { revalidate: 60 }, // cache for 60 seconds
      }
    );

    if (!resp.ok) return [];

    const data = (await resp.json()) as GitHubIssueResponse[];
    if (!Array.isArray(data)) return [];

    return data
      .filter((i) => !i.pull_request)
      .map((i) => {
        const labels = (i.labels || []).map((l) => l.name);
        const priority = issuePriority(labels);
        return {
          number: i.number,
          title: i.title,
          labels,
          createdAt: i.created_at.slice(0, 10),
          updatedAt: i.updated_at.slice(0, 10),
          url: i.html_url,
          priority,
          inProgress: labels.includes(CLAUDE_WORKING_LABEL),
        };
      })
      .filter((i) => !i.labels.some((l) => SKIP_LABELS.has(l)))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });
  } catch {
    return [];
  }
}

export default async function GitHubIssuesPage() {
  const issues = await fetchIssues();
  const inProgress = issues.filter((i) => i.inProgress);
  const queue = issues.filter((i) => !i.inProgress).slice(0, 20);
  const hasToken = !!process.env.GITHUB_TOKEN;

  return (
    <article className="prose max-w-none">
      <h1>GitHub Issues</h1>
      <p className="text-muted-foreground">
        Live view of open GitHub issues.{" "}
        {hasToken ? (
          <>
            <span className="font-medium text-foreground">
              {issues.length}
            </span>{" "}
            open issues,{" "}
            <span className="font-medium text-foreground">
              {inProgress.length}
            </span>{" "}
            in progress.
          </>
        ) : (
          <span className="text-yellow-600">
            GITHUB_TOKEN not set — data unavailable.
          </span>
        )}
      </p>

      {!hasToken ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">GitHub token required</p>
          <p className="text-sm">
            Set the <code className="text-xs">GITHUB_TOKEN</code> environment
            variable to load live issue data.
          </p>
        </div>
      ) : (
        <>
          <h2 className="mt-6 mb-3">In Progress ({inProgress.length})</h2>
          {inProgress.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No issues currently labeled{" "}
              <code className="text-xs">claude-working</code>.
            </p>
          ) : (
            <IssuesTable data={inProgress} defaultSort="number" />
          )}

          <h2 className="mt-8 mb-1">Priority Queue</h2>
          <p className="text-sm text-muted-foreground mb-3">
            {(() => {
              const queuedCount = issues.filter((i) => !i.inProgress).length;
              return queuedCount > 20
                ? `Showing top 20 of ${queuedCount} queued issues. `
                : `${queuedCount} queued issues. `;
            })()}
            <a
              href={`https://github.com/${REPO}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View all on GitHub
            </a>
            .
          </p>
          {queue.length === 0 ? (
            <p className="text-muted-foreground text-sm">No open issues.</p>
          ) : (
            <IssuesTable data={queue} defaultSort="priority" />
          )}
        </>
      )}
    </article>
  );
}
