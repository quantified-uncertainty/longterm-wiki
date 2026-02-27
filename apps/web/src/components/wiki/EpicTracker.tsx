import { fetchDetailed } from "@/lib/wiki-server";

interface GitHubIssueData {
  number: number;
  title: string;
  state: string;
  labels: string[];
  created_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
}

interface EpicTrackerProps {
  issues: number[];
}

const REPO_URL = "https://github.com/quantified-uncertainty/longterm-wiki";

function FallbackList({ issues }: { issues: number[] }) {
  return (
    <div className="not-prose my-6 rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">
        Tracked Issues
      </h3>
      <ul className="space-y-1">
        {issues.map((n) => (
          <li key={n}>
            <a
              href={`${REPO_URL}/issues/${n}`}
              className="text-sm text-blue-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              #{n}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function EpicTracker({ issues }: EpicTrackerProps) {
  let result;
  try {
    result = await fetchDetailed<{ issues: GitHubIssueData[] }>(
      `/api/github/issues?numbers=${issues.join(",")}`,
      { revalidate: 300 }
    );
  } catch (_e) {
    return <FallbackList issues={issues} />;
  }

  if (!result.ok) {
    return <FallbackList issues={issues} />;
  }

  const data = result.data.issues;
  const closed = data.filter((i) => i.state === "closed").length;
  const total = data.length;
  const pct = total > 0 ? Math.round((closed / total) * 100) : 0;

  return (
    <div className="not-prose my-6 rounded-lg border border-border/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Epic Progress</h3>
        <span className="text-xs text-muted-foreground">
          {closed}/{total} closed ({pct}%)
        </span>
      </div>
      {/* Progress bar */}
      <div className="h-2 w-full rounded-full bg-muted mb-4">
        <div
          className="h-2 rounded-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* Issues table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="pb-2 pr-4">#</th>
              <th className="pb-2 pr-4">Title</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2">Labels</th>
            </tr>
          </thead>
          <tbody>
            {data.map((issue) => (
              <tr
                key={issue.number}
                className="border-b border-border/40 last:border-0"
              >
                <td className="py-1.5 pr-4">
                  <a
                    href={`${REPO_URL}/issues/${issue.number}`}
                    className="text-blue-600 hover:underline tabular-nums"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{issue.number}
                  </a>
                </td>
                <td className="py-1.5 pr-4">{issue.title}</td>
                <td className="py-1.5 pr-4">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      issue.state === "closed"
                        ? "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300"
                        : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                    }`}
                  >
                    {issue.state}
                  </span>
                </td>
                <td className="py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {issue.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
